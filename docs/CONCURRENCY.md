# Session Concurrency Model

How the session core stays correct when two events touch one session at the same time, on both hosts
that run it: a Cloudflare Durable Object today and a Node process (the AWS host) alongside it. The
rules in this document are the contract new code in `packages/control-plane/src/session/*` and
`src/sandbox/lifecycle/*` is reviewed against.

## The rules

1. **Every `await` is a boundary.** A handler that reads session state, awaits anything, and then
   writes based on that read is racing every other event for the same session. This is the one rule
   for both hosts; the sections below say where each host is stricter, and none of that strictness
   may be relied on in new code.
2. **A write is guarded in one of three ways.** Either the read it depends on happens in the same
   continuation as the write (no `await` between them); or the statement carries the condition
   (`UPDATE … WHERE status = ?`) and the caller acts on `meta.changes` / `rowsWritten`; or the write
   commutes with every update another event could make meanwhile, and a comment at the site says
   why. A check made before an `await` guards nothing.
3. **No per-session mutex.** The Node host does not serialize a session's events. A strict lock
   would deadlock the runtime's own re-entrant calls and would hide, on one host, races that exist
   on the other.
4. **One session runtime per process.** On Node, a session lives in exactly one
   `SessionRuntimeRegistry`, in exactly one process. The same session is never opened by two workers
   or two processes. In-memory guards (`isSpawningSandbox`, the pull-request creation claims) are
   valid only because of this rule, and on Cloudflare only within one activation.
5. **A runtime never calls its own session through the runtime client.** `SessionRuntimeClient` is
   for other sessions (parent notifications, child spawns, the sweeps). On Node a self-call
   re-enters the runtime synchronously; on Cloudflare a self-stub call waits on the input gate. No
   site does this today; do not add one.

## What the Durable Object guarantees

One Durable Object handles one session. Its input gate delivers one event at a time, and while a
handler is running JavaScript no other event is delivered. The gate stays closed across **storage**
awaits (`ctx.storage`: `getAlarm`, `setAlarm`, `deleteAlarm`, and the KV/SQL storage API) and opens
across every other await: a `fetch` to D1 or a provider, `crypto.subtle`, a WebSocket send that
returns a promise. At an open gate the next queued event runs to its own first await before the
suspended handler resumes.

Three kinds of await occur in the session core, and they differ on this host:

- **Synchronous session SQL.** The per-session store is the Durable Object's SQLite (`sql.exec`),
  read and written through the repositories in `src/session/*-repository.ts`. These calls are
  synchronous; a read and a write with no `await` between them are atomic with respect to every
  other event. Two repository methods await before their write (`updateSandboxAccess` encrypts,
  `storeTtyd` mints a token first); they are ordinary awaits, below.
- **Alarm-storage awaits.** `AlarmScheduler.schedule` / `cancel` / `rehydrate`
  (`session/alarm/scheduler.ts`) await the platform's `AlarmScheduleStore`, which the Cloudflare
  platform supplies as `ctx.storage` (`cloudflare/session-platform.ts`). These are storage awaits:
  the gate stays closed, and nothing else runs on the session until they resolve.
- **Ordinary awaits.** Everything else: D1 through `SqlDatabase`, provider calls, `crypto.subtle`
  (the prompt fingerprint, token hashing, secret encryption), outbound `fetch`. The gate opens. A
  cancel request can land while a prompt handler waits on its fingerprint hash
  (`enqueuePromptCore`), while a sandbox spawn waits on the provider, or while a terminal message is
  being projected to D1. `connection-authenticator.ts` documents this for the token-hash await of
  the sandbox handshake and re-reads the session after it.

A Durable Object stays resident across events while it is busy or recently active, and is evicted
while idle (or on a deploy, a memory limit, or an error). In-memory state therefore does carry
across the events one activation handles, which is what makes the lifecycle manager's
`isSpawningSandbox` and the pull-request creation claims meaningful, and does not carry across
activations, which is why the persisted sandbox status is the cross-activation protection.

## What the Node host guarantees

`src/node/session-runtime-registry.ts` is the Node counterpart of one Durable Object per session: it
opens the session's store on first touch, keeps the runtime resident while it has sockets,
background tasks, or a held activity lease, and retires it when idle. Only the runtime's transitions
(`opening → resident → quiescing → retired`) are serialized; events on a resident runtime are not.
The set of interleavings on Node is a **superset** of the Durable Object's:

- Ordinary awaits interleave exactly as they do on the Durable Object.
- Alarm-storage awaits interleave too. There is no gate: an await on the host alarm index
  (`src/node/host-alarm-index.ts`, synchronous SQLite behind a promise) yields to the microtask
  queue, and any continuation that is already runnable executes in between. A sequence that is safe
  on Cloudflare only because it straddles an alarm-storage await (`attachSandbox`, `stopExecution`
  after its stop deadline is armed) is not safe on Node.
- The runtime is long-lived. In-memory state (spawn flags, creation claims, the registry's leases)
  persists across events, so a flag left set by a thrown handler stays set until the runtime is
  retired. Clear such flags in `finally`, as the lifecycle manager does.

Synchronous session SQL is the same on both hosts: `node:sqlite`, one file per session, opened by
one process. The registry is the ownership boundary: a second process, or a second registry in the
same process, must never open a session file that another has resident. Deploy the Node host as one
process per session set; there is no leader election and none is needed while this holds.

Bridge prompts are serialized by the control plane's message queue, not by the host: at most one
message is `processing` per session, claimed by a conditional update, on both hosts.

## Why there is no mutex

A per-session mutex looks like the obvious repair. It is rejected for three reasons.

- **It deadlocks on re-entry.** A session handler that reaches its own session through the runtime
  client (rule 5) would wait on a lock its own request holds. Rule 5 forbids the call, but a lock
  turns a forbidden call into a hang rather than a bug report.
- **It hides races that exist on the other host.** Every sequence a mutex would protect on Node
  across an ordinary await is unprotected on the Durable Object, where the gate opens at the same
  awaits. A mutex would make the Node test suite green while production on Cloudflare keeps the
  race.
- **It serializes what does not need serializing.** Most events on a session are independent
  (heartbeats, token streams, presence). The few sequences that do conflict are protected by a
  condition on the write, which costs nothing when there is no contention.

## Guard forms

Use the first form that fits.

**Same continuation.** Read, decide, write, with no `await` between. Synchronous session SQL makes
this atomic with respect to every other event.

```ts
const session = this.repository.getSession();
if (!session || !isSessionPromptable(session.status)) throw new SessionNotPromptableError(...);
this.messageRepository.createMessage(...); // same turn as the read
```

The check must be _after_ the last await, not before the first one. `enqueuePromptCore` read the
session's status, awaited a hash, then inserted: the check guarded nothing (#1761).

**Conditional statement plus changes check.** When the decision was made in an earlier continuation,
or when another writer may have moved the row, make the write carry the condition and let the caller
learn whether it applied.

```ts
const claimed = this.sql.exec(
  `UPDATE messages SET status = 'processing', started_at = ?
   WHERE id = ? AND status = 'pending'
     AND NOT EXISTS (SELECT 1 FROM messages WHERE status = 'processing')
   RETURNING id`,
  startedAt,
  messageId
);
if (claimed.toArray().length !== 1) return false; // lost the claim; do not dispatch
```

This is the prompt claim from #1479 and the two-phase spawn reservation from #1606
(`updateSandboxAuthTokenHash` applies only while the reserved identity is still the row's). The D1
session index uses the same shape with an `updated_at` fence.

**Commuting write.** A write that leaves the same final state whichever order it lands in relative
to every update another event could make meanwhile. Repeatability is not enough: an unconditional
`SET last_activity = ?` is repeatable, and still erases a newer heartbeat if its timestamp was read
before an await. What commutes: clearing a deadline by message id (nothing sets it meanwhile),
recording a fresh artifact id, a `MAX(...)` timestamp, recording the provider object id of the
sandbox this attempt created. Say why at the site.

What is not a guard: an in-memory flag on Cloudflare across activations, a status read before an
`await`, a broadcast (clients are not the store).

## Review checklist

For any change under `src/session/*` or `src/sandbox/lifecycle/*` that adds or moves an `await`:

- [ ] Name every repository read before the await whose value a write after the await depends on.
- [ ] For each, either move the read after the await (same continuation as the write), or make the
      write conditional and handle the "did not apply" branch, or show that the write commutes with
      every concurrent update and say so in a comment at the site.
- [ ] Add the site to the audit table below with its classification.

CONTRIBUTING.md carries the one-line version of this checklist.

## Audit (2026-09-04)

Every read → `await` → dependent-write sequence in the seven files the audit covers, classified:

- **(a)** guarded: same continuation, or a conditional statement with a changes check
- **(b)** commuting: the same final state whichever order the writes land in
- **(c)** unguarded: a concrete interleaving produces a wrong state

A (c) row names the fix that closes it. The fixes are separate PRs; a row stays (c) until its PR
merges, whatever the PR's state. As of this revision: #1761, #1762, and #1764 are open; the others
are planned and not yet opened.

"In-memory" means the guard is a per-runtime flag or claim, valid under rule 4 and, on Cloudflare,
only within one activation.

### `src/session/message-queue.ts`

| Site                                                                   | Sequence                                                                                                                                   | Class     | Note                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `enqueuePromptCore` promptability check → `await fingerprintWebPrompt` | session status read → hash await → idempotency read, capacity, insert, `transition("active")`                                              | (c)       | A cancel or archive landing during the hash left the insert and the `active` transition unguarded: the closed session accepted a message and flipped back to `active`. Fix: the check moves after the await, into the insert's continuation (#1761).                                                                                                                                                         |
| `enqueuePromptCore` insert → `transition("active")`                    | insert → transition reads and writes the session in the same turn                                                                          | (a)       | Same continuation.                                                                                                                                                                                                                                                                                                                                                                                           |
| `handlePromptMessage` / `enqueuePromptFromApi` pre-checks              | promptable + capacity checks → participant writes → `enqueuePromptCore`                                                                    | (a)       | Same continuation up to the core's own check. The API path passes no `clientRequestId`, so it never awaits before the insert.                                                                                                                                                                                                                                                                                |
| `redrivePendingAutofix`                                                | message status + session reads → `transition("active")` → `processMessageQueue`                                                            | (a)       | Same continuation; the queue re-reads.                                                                                                                                                                                                                                                                                                                                                                       |
| `processMessageQueue`, socket path                                     | session, awaiting-stop, processing, next-pending reads → `await getProviderAuthenticationError` → `failMessage` / `startMessageProcessing` | (a)       | `startMessageProcessing` is the #1479 claim (`status='pending' AND NOT EXISTS processing`); `recordMessageCompletion` takes the expected status. A cancel during the await fails the pending row, so the claim is lost cleanly.                                                                                                                                                                              |
| `processMessageQueue`, no-socket path                                  | next-pending read → `await getProviderAuthenticationError` → `sandbox_spawning` broadcast, `spawnSandbox()` submitted                      | (c)       | No claim on this path: a cancel during the await closes the session and fails the prompt, and the continuation still starts a sandbox for it (`spawnSandbox` checks sandbox state, not session liveness; the bridge is rejected at the handshake and the sandbox orphaned until the next stop). Fix: re-read session liveness and the prompt's `pending` status in the spawn's continuation (PR 5, planned). |
| `processMessageQueue` after send                                       | send fails → `updateMessageToPending`; send ok → `updateLastActivity(now)`                                                                 | (a) / (c) | `updateMessageToPending` is `WHERE status='processing'`. `now` was read before the auth await and `updateSandboxLastActivity` is an unconditional assignment: a heartbeat that landed meanwhile is moved backwards and the inactivity window shortened. Fix: the write becomes `MAX(last_activity, ?)` (PR 7, planned).                                                                                      |
| `stopExecution`                                                        | processing read → `failMessage` → `markMessageAwaitingStopConfirmation` → `await schedule` → `await reconcileAfterExecution`               | (a)       | The failure is a conditional completion; the deadline write is in the same turn. The `schedule` await is alarm storage (closed gate on Cloudflare, a boundary on Node); the reconcile after it is covered by #1762.                                                                                                                                                                                          |
| `recoverStopConfirmationTimeout` → `resumeAfterSandboxTermination`     | awaiting-stop read → `await terminateUnresponsiveSandbox` → re-read → `clearMessageAwaitingStopConfirmation(id)`                           | (b)       | Clears by id; no other path sets a deadline while one is pending, so the clear commutes.                                                                                                                                                                                                                                                                                                                     |
| `handleFatalSandboxFailure`                                            | `terminateFailedSandbox` (sync writes, then provider await) ‖ `failStuckProcessingMessage`                                                 | (a)       | Conditional completion; in-memory `isTerminatingSandbox`.                                                                                                                                                                                                                                                                                                                                                    |
| `cancelQueuedPrompt`                                                   | `cancelPendingMessage` → `reconcileAfterQueueRemoval`                                                                                      | (a)       | The repository transaction re-reads status and deletes `WHERE status='pending'`; reconcile runs in the same turn.                                                                                                                                                                                                                                                                                            |
| `failStuckProcessingMessage`, `cancelExecution`, `enqueueAutofix`      | reads → conditional completions / `admitAutofixMessage` transaction                                                                        | (a)       | All synchronous up to the projection awaits.                                                                                                                                                                                                                                                                                                                                                                 |

### `src/session/sandbox-events/processor.ts` and `execution.handler.ts`

| Site                                               | Sequence                                                                                                                                      | Class | Note                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `processSandboxEvent` → `handleExecutionComplete`  | processing-message read → `recordMessageCompletion(event, now, "processing")`                                                                 | (a)   | The context is read and the conditional completion applied in one continuation; `execution_complete` for a message no longer processing takes the `already_stopped` branch.                                                                                                                         |
| `handleExecutionComplete` after completion         | completion → `await projectTerminalMessage` (D1) → broadcasts → `await reconcileAfterExecution` → `transition(completed \| failed \| active)` | (c)   | An archive (allowed: no unfinished messages remain) or cancel landing during the projection await was overwritten: reconcile derived `completed`/`failed` from message state and `transition` wrote it over `archived`/`cancelled`. Fix: reconcile leaves a session that is no longer live (#1762). |
| `handleExecutionComplete` `already_stopped` branch | `clearMessageAwaitingStopConfirmation(event.messageId)`                                                                                       | (b)   | Clear by id; commutes as above.                                                                                                                                                                                                                                                                     |
| `handleExecutionComplete` tail                     | `updateLastActivity(context.now)` → `await scheduleInactivityCheck` → `processMessageQueue`                                                   | (c)   | `context.now` was read before the projection and reconcile awaits; the same non-monotonic overwrite as the queue's. Same fix (PR 7, planned). The queue re-reads everything.                                                                                                                        |

### `src/session/session-status-service.ts`

| Site                                                    | Sequence                                                                                       | Class | Note                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transition`                                            | session read → `updateSessionStatus` → `await` index `updateStatus` → `finalizeChildAdmission` | (a)   | Local write in the read's continuation. The index write carries `WHERE updated_at <= ?`; the admission-lease delete commutes (nothing re-creates the lease). `transition` itself does not check the current status: every caller reads it in the same turn.                                                                                             |
| `transition` same-status branch                         | `await` index `updateStatus` → metrics                                                         | (a)   | Fenced as above.                                                                                                                                                                                                                                                                                                                                        |
| `repairIndexStatus`                                     | session read → `await repairStatus` → `finalizeChildAdmission`                                 | (a)   | `repairStatus` is `WHERE status = 'created'`.                                                                                                                                                                                                                                                                                                           |
| `cancel`                                                | session read → status write → terminalize messages → projection                                | (a)   | Both mutations before the first await, as its contract states.                                                                                                                                                                                                                                                                                          |
| `reconcileAfterExecution`, `reconcileAfterQueueRemoval` | message-count reads → `transition`                                                             | (c)   | The reads are fresh, but the decision ignored `cancelled`/`archived`, so a reconcile reached after an await (row above) moved a closed session. Fix: both return without transitioning when the session is no longer live (#1762).                                                                                                                      |
| `settleFromMessageState`                                | message-count reads → `transition`                                                             | (a)   | Same continuation. Deliberately not guarded like the reconciles: it is the unarchive path and must leave `archived`.                                                                                                                                                                                                                                    |
| `syncSessionMetrics`                                    | four local reads → background index `updateMetrics`                                            | (c)   | The D1 write is an unfenced overwrite and the projections run in the background, so an older projection can land after a newer one and stay: nothing guarantees a later settled turn to recompute. Fix: `updateMetrics` takes the transition's `updated_at` and applies `WHERE updated_at <= ?`, the fence `updateStatus` already uses (PR 6, planned). |

### `src/session/alarm/handler.ts`

| Site                       | Sequence                                                                                                                          | Class | Note                                                                  |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----- | --------------------------------------------------------------------- |
| `handle` execution timeout | `await flushPending` → `await recoverStopConfirmationTimeout` → processing read → `failStuckProcessingMessage` / `await schedule` | (a)   | The read follows the awaits; the failure is a conditional completion. |
| `handle` lifecycle         | `await lifecycleManager.handleAlarm()` → `failStuckProcessingMessage` → `resumeAfterSandboxTermination`                           | (a)   | Conditional completion; the resume clears by id and re-reads.         |

### `src/session/pull-request-service.ts`

| Site                                  | Sequence                                                                                           | Class | Note                                                                                                                                                                          |
| ------------------------------------- | -------------------------------------------------------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createPullRequest` admission         | session + repository reads → `claims.claim(repo)`                                                  | (a)   | In-memory claim per target repository, taken before the first await; one creation per repository at a time. Valid under rule 4.                                               |
| `createPullRequest` branch writes     | `listArtifacts` → provider awaits → push → `updateSessionRepositoryBranch` / `updateSessionBranch` | (b)   | Values derive from the request, not the read, and only this request (under the claim) writes this repository's branch; the pre-await comparison only skips a redundant write. |
| `createPullRequest` artifact + record | provider `createPullRequest` → `createArtifact` (new id) → `await` D1 upsert                       | (a)   | Insert of a fresh id under the claim; the D1 upsert carries its monotonic `provider_updated_at` guard.                                                                        |
| `applyLiveSnapshot`                   | `await` D1 upsert → re-read artifact → staleness check → `updateArtifact`                          | (a)   | The apply-time re-read is the pattern: authority first, then a guarded mirror write in the re-read's continuation.                                                            |

### `src/sandbox/lifecycle/manager.ts`

| Site                                                                                           | Sequence                                                                                                                                  | Class | Note                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `spawnSandbox` → `doSpawn` / `restoreFromSnapshot` / `resumeSandbox` entry                     | circuit-breaker + sandbox reads → decision → `isSpawningSandbox = true` → `enterProviderStartup` persists `spawning`/`connecting`         | (a)   | Same continuation from the read to the persisted status; `enterProviderStartup` writes before its alarm-storage await. In-memory flag for the rest of the attempt.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `reserveSpawnIdentity`                                                                         | reservation write → `await` alarm storage → `await hashToken` → `updateSandboxAuthTokenHash(expectedSandboxId)`                           | (c)   | The hash applied `WHERE modal_sandbox_id = ?` (#1606), which excludes a newer reservation but not a cancel of this one: the cancel handler sets the sandbox `stopped` without changing its id, the hash then went live, and the provider was called for a closed session. Fix: the publication also requires `status = 'spawning'`, so such an attempt takes the existing superseded exit without failure writes (#1764).                                                                                                                                                                                                            |
| `stopPriorProviderSandbox`                                                                     | object-id read → `await stop` → `updateSandboxModalObjectId(null)`                                                                        | (a)   | Only spawn paths write the object id, and they hold the in-memory flag.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| provider object id (`doSpawn`, `restoreFromSnapshot`, `resumeSandbox`)                         | provider await → `updateSandboxModalObjectId`                                                                                             | (b)   | Records the provider-side sandbox this attempt created; no other writer sets the object id during the attempt (the flag), and a later stop needs it whatever status the row reached meanwhile.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| access publication (`storeCodeServer`, `storeVnc`, `storeTtyd`, `storeAndBroadcastTunnelUrls`) | provider await → (`await mintJwt`) → `updateSandboxAccess` (`await encrypt` inside) / `updateSandboxTunnelUrls` → unconditional row write | (c)   | A termination during the provider, JWT, or encryption await (alarm, cancel, unresponsive-sandbox path) clears access and retires the row; the late write republishes a URL and credential onto a dead sandbox, which the session snapshot then serves. A status-only condition on the attempt does not cover it: the bridge may legitimately have set `ready` meanwhile. Fix: the repository writes apply only while the row is not in a dead status (`stopped`, `stale`, `failed`), after the encryption await (PR 7, planned). Identity is stable within the attempt under the in-memory flag, so no identity condition is needed. |
| `finishProviderStartup`                                                                        | provider await → socket / status read → `updateSandboxStatus("connecting")`                                                               | (c)   | A provider call longer than the connecting timeout lets the alarm mark the row `failed` (or a connected-then-dead bridge mark it `stale`); the late return overwrote that with `connecting` and broadcast it. Fix: advance only from `spawning` (#1764).                                                                                                                                                                                                                                                                                                                                                                             |
| failure branches (`doSpawn` catch, restore failure, `resumeSandbox` catch)                     | provider await → `incrementCircuitBreakerFailure` → `updateSandboxStatus("failed")` → `reportSandboxError`                                | (c)   | A bridge that connected during the provider call set the row `ready` and attached its socket; a provider error after that (a post-create timeout) marked the working sandbox `failed`, which the alarm treats as dead and stops monitoring, and persisted a spawn error the snapshot serves. Fix: fail only from the attempt's own `spawning`/`connecting` status (#1764). The circuit-breaker increment stays unconditional: it counts the attempt. The retry-from-base path re-reserves the identity unconditionally and supersedes such a bridge; recorded, not changed.                                                          |
| `triggerSnapshot` status restore                                                               | sandbox read → `snapshotting` → `await takeSnapshot` → `updateSandboxStatus(previousStatus)`                                              | (c)   | A cancel, heartbeat-stale alarm, or unresponsive-sandbox termination during the snapshot set `stopped`/`stale`, cleared access, and detached the socket; the snapshot's return restored the pre-snapshot `ready`, so the spawn decision waited for a reconnect that cannot come. Fix: restore only from `snapshotting` (#1764).                                                                                                                                                                                                                                                                                                      |
| `triggerSnapshot` image stamp                                                                  | sandbox read → `await takeSnapshot` → `updateSandboxSnapshotImageId(sandbox.id, …)`                                                       | (c)   | The stamp was keyed by row id, and spawn reservations reuse the one row: a sandbox terminated and replaced during the snapshot handed its image to the replacement as its restore image. Fix: the stamp applies only while the row still carries the sandbox the snapshot was taken of (`recordSandboxSnapshot`, `modal_sandbox_id IS ?`, captured before the await) (#1764).                                                                                                                                                                                                                                                        |
| `handleAlarm` branches                                                                         | sandbox read → decision → status write + access clears → provider stop / `await triggerSnapshot` → detach                                 | (a)   | Status and access writes precede the awaits; a snapshot taken with a terminal status does not restore it. Between the `stopped` write and the detach the still-attached socket can take one more dispatch; the same alarm turn fails and re-dispatches it (`failStuckProcessingMessage`, `resumeAfterSandboxTermination`).                                                                                                                                                                                                                                                                                                           |
| `terminateUnresponsiveSandbox`, `terminateFailedSandbox`                                       | sandbox read → status + access writes → detach → `await stop`                                                                             | (a)   | Writes in the read's continuation; `isTerminatingSandbox` in memory.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `warmSandbox`                                                                                  | sandbox read → `spawnSandbox`                                                                                                             | (a)   | Same continuation into the reservation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `lookupImageBuildForSpawn`, `markImageBuildRestoreFailed`                                      | D1 image-build rows                                                                                                                       | —     | Global store, outside the session core; the image-build state machine owns its own guards.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

### `src/session/connection-authenticator.ts` (sandbox handshake)

Not in the roadmap's list; included because the audit's own reference to it needed qualifying.

| Site            | Sequence                                                                                                                                           | Class | Note                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `authorize`     | sandbox read → `await isValidSandboxToken` (hash) → session, sandbox, identity re-read → accept / reject                                           | (a)   | The reference implementation of a re-read after an ordinary await; every guard runs on the post-await read.                                                                                                                                                                                                                                                                                                                                             |
| `attachSandbox` | activity + heartbeat writes → `await scheduleInactivityCheck` (alarm storage) → adopt socket, `onSandboxConnected`, `updateSandboxStatus("ready")` | (c)   | Safe on Cloudflare only because the await is alarm storage. On Node a cancel, a termination, or a replacement reservation landing there is followed by an obsolete socket being adopted and `ready` written over `stopped`. Fix: re-read session liveness, reconnect-blocked status, and the presented identity in the adoption's continuation, and close the socket instead (PR 8, planned). Adoption is an admission protocol, not a repository fold. |

Ten (c) classes remain open across the tables above. Their fixes, each behavior-preserving on
Cloudflare outside the interleaving it closes:

- #1761 (open): `enqueuePromptCore` re-checks promptability after the fingerprint await.
- #1762 (open): `reconcileAfterExecution` and `reconcileAfterQueueRemoval` leave a session that is
  no longer live.
- #1764 (open): `SandboxStorage.transitionSandboxStatus(from, to)` and
  `recordSandboxSnapshot(modalSandboxId, …)` replace the unconditional status writes and the image
  stamp that follow a provider await; the hash publication also requires `spawning`.
- PR 5 (planned): the no-socket dispatch path re-reads session liveness and the prompt's status
  before submitting a spawn.
- PR 6 (planned): `updateMetrics` fenced on the transition's `updated_at`.
- PR 7 (planned): `updateSandboxLastActivity` becomes monotonic; access and tunnel publication apply
  only onto a live row.
- PR 8 (planned): `attachSandbox` re-validates admission after the alarm-storage await.

### Fold inventory

Sections that make two or more repository calls between a read and a dependent write. Each is a
candidate to become one atomic repository operation; that is the prerequisite for the post-October
async-repository engine (epic E8, COL-129), where the same-continuation guard stops existing and
only the conditional-statement and commuting forms survive.

| #   | Section                                                                             | Calls between read and dependent write                                                                         | Folded operation                                                                                   |
| --- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| F1  | `enqueuePromptCore`                                                                 | idempotency lookup, unfinished count, attachment resolution + claim, insert, status transition, position count | `admitPrompt(request)`; `admitAutofixMessage` is the existing model                                |
| F2  | `processMessageQueue` dispatch                                                      | awaiting-stop, processing, next-pending, author reads, claim + event insert                                    | `claimNextPrompt()` returning the claimed row with its author                                      |
| F3  | `stopExecution`                                                                     | processing read, conditional completion, stop-confirmation deadline                                            | `stopProcessingMessage(now, deadline)`                                                             |
| F4  | `SessionStatusService.transition`                                                   | session read, unconditional status write                                                                       | `updateSessionStatusFrom(observed, next)` (compare-and-set)                                        |
| F5  | `reconcileAfterExecution` / `reconcileAfterQueueRemoval` / `settleFromMessageState` | unfinished count, latest terminal message, session read, status write                                          | `settleSessionStatus(outcome)`                                                                     |
| F6  | `triggerSnapshot`                                                                   | sandbox read, `snapshotting` write, image stamp, status restore                                                | `beginSnapshot()` / `completeSnapshot(imageId)`; #1764 makes the stamp and the restore conditional |
| F7  | `reserveSpawnIdentity`                                                              | reservation, hash publication                                                                                  | Already two-phase by design (#1606); keep                                                          |
| F8  | `handleAlarm` termination branches                                                  | sandbox read, status write, four access clears, tunnel clear                                                   | `retireSandbox(status)`                                                                            |
| F9  | `createPullRequest`                                                                 | session + repository reads, branch writes, artifact insert, D1 record                                          | Store-backed creation claim replaces the in-memory one once rule 4 is relaxed                      |
| F10 | `applyPullRequestSnapshot`                                                          | D1 upsert, artifact re-read, staleness check, artifact update                                                  | Already the conditional pattern; becomes one operation under async repositories                    |
| F11 | `syncSessionMetrics`                                                                | message count, active duration, artifact list, session cost → one index write                                  | Already one write; PR 6 adds the `updated_at` fence                                                |

`attachSandbox` is not in the inventory: socket adoption cannot be a repository operation, and its
guard is the admission re-check described in its row.

## Related

- ADR 0003 (session snapshot handoff) applies rule 2 to the subscribe path: the snapshot read and
  the socket registration happen with no `await` between them.
- #1479 (prompt claim) and #1606 (spawn admission) are the reference implementations of the
  conditional form; `authorize` in `connection-authenticator.ts` is the reference re-read after an
  ordinary await (its `attach` half is in the audit).
- The roadmap items: H-3 (this document, COL-99), H-2 (the registry, COL-98), E8 (async
  repositories, COL-129).
