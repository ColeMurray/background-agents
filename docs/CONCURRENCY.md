# Session Concurrency Model

How the session core stays correct when two events touch one session at the same time, on both hosts
that run it: a Cloudflare Durable Object today and a Node process (the AWS host) alongside it. The
rules in this document are the contract new code in `packages/control-plane/src/session/*` and
`src/sandbox/lifecycle/*` is reviewed against.

## The rules

1. **Every `await` is a boundary.** A handler that reads session state, awaits anything, and then
   writes based on that read is racing every other event for the same session. This is true on the
   Durable Object today, not only on Node.
2. **A read that a write depends on happens in the same continuation as the write, or the write
   carries the condition itself.** Either the check and the mutation run with no `await` between
   them, or the statement is conditional (`UPDATE … WHERE status = ?`) and the caller acts on
   `meta.changes` / `rowsWritten`. A check made before an `await` guards nothing.
3. **Otherwise the write is idempotent.** Setting a value the row already carries, deleting by id,
   clearing a field: safe to repeat, safe to lose to a later writer.
4. **No per-session mutex.** The Node host does not serialize a session's events. A strict lock
   would deadlock the runtime's own re-entrant calls and would hide, on one host, races that exist
   on the other.
5. **One session runtime per process.** On Node, a session lives in exactly one
   `SessionRuntimeRegistry`, in exactly one process. The same session is never opened by two workers
   or two processes. In-memory guards (`isSpawningSandbox`, the pull-request creation claims) are
   valid only because of this rule.
6. **A runtime never calls its own session through the runtime client.** `SessionRuntimeClient` is
   for other sessions (parent notifications, child spawns, the sweeps). On Node a self-call
   re-enters the runtime synchronously; on Cloudflare a self-stub call waits on the input gate. No
   site does this today; do not add one.

## What the Durable Object guarantees

One Durable Object handles one session. Its input gate delivers one event at a time, and while a
handler is running JavaScript no other event is delivered. The gate stays closed across **storage**
awaits (`ctx.storage`, `setAlarm`) and opens across every other await: a `fetch` to D1 or a
provider, `crypto.subtle`, a WebSocket send that returns a promise. At an open gate the next queued
event runs to its own first await before the suspended handler resumes.

The per-session store is the Durable Object's synchronous SQLite (`sql.exec`), read and written
through the repositories in `src/session/*-repository.ts`. Because it is synchronous there are no
storage awaits in the session core at all; a repository call completes inside the continuation that
made it. Every `await` in the core is therefore a non-storage await, and every one of them opens the
gate.

Consequence: the set of interleavings the core must survive is already the set a Node host produces.
A cancel request can land while a prompt handler waits on its fingerprint hash
(`enqueuePromptCore`), while a sandbox spawn waits on the provider, or while a terminal message is
being projected to D1. `connection-authenticator.ts` documents the same fact for the sandbox
handshake: token hashing is a non-storage await, so admission re-reads the session after it.

The Durable Object also gives one alarm slot per session, delivered as an event like any other, and
evicts the object between events, so nothing in memory outlives a request except by accident. The
lifecycle manager's in-memory flags survive only within one activation, which is why the persisted
sandbox status carries the cross-request protection.

## What the Node host guarantees

`src/node/session-runtime-registry.ts` is the Node counterpart of one Durable Object per session: it
opens the session's store on first touch, keeps the runtime resident while it has sockets,
background tasks, or a held activity lease, and retires it when idle. Only the runtime's transitions
(`opening → resident → quiescing → retired`) are serialized; events on a resident runtime are not.
Two events for one session interleave at their awaits exactly as they do on the Durable Object, with
two differences:

- Nothing corresponds to the closed gate. An await on the alarm store or the session store yields to
  the microtask queue, so a continuation of another handler that is already runnable can execute in
  between. Treat these awaits as boundaries too, and keep the storage-await exemption out of new
  code.
- The runtime is long-lived. In-memory state (spawn flags, creation claims, the registry's leases)
  persists across events, so a flag left set by a thrown handler stays set until the runtime is
  retired. Clear such flags in `finally`, as the lifecycle manager does.

The per-session store is `node:sqlite`, synchronous, one file per session, opened by one process.
The registry is the ownership boundary: a second process, or a second registry in the same process,
must never open a session file that another has resident. Deploy the Node host as one process per
session set; there is no leader election and none is needed while this holds.

Bridge prompts are serialized by the control plane's message queue, not by the host: at most one
message is `processing` per session, claimed by a conditional update, on both hosts.

## Why there is no mutex

A per-session mutex looks like the obvious repair. It is rejected for three reasons.

- **It deadlocks on re-entry.** A session handler that reaches its own session through the runtime
  client (rule 6) would wait on a lock its own request holds. Rule 6 forbids the call, but a lock
  turns a forbidden call into a hang rather than a bug report.
- **It hides races that exist on the other host.** Every sequence a mutex would protect on Node is
  unprotected on the Durable Object, where the gate opens at the same awaits. A mutex would make the
  Node test suite green while production on Cloudflare keeps the race.
- **It serializes what does not need serializing.** Most events on a session are independent
  (heartbeats, token streams, presence). The few sequences that do conflict are protected by a
  condition on the write, which costs nothing when there is no contention.

## Guard forms

Use the first form that fits.

**Same continuation.** Read, decide, write, with no `await` between. Synchronous SQLite makes this
atomic with respect to every other event.

```ts
const session = this.repository.getSession();
if (!session || !isSessionPromptable(session.status)) throw new SessionNotPromptableError(...);
this.messageRepository.createMessage(...); // same turn as the read
```

The check must be _after_ the last await, not before the first one. `enqueuePromptCore` (fixed in
this audit) read the session's status, awaited a hash, then inserted: the check guarded nothing.

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

**Idempotent write.** A write that is correct whichever order it lands in: clearing a deadline by
message id, recording a provider object id, stamping a snapshot image. Say so in the table below
rather than adding a guard that protects nothing.

What is not a guard: an in-memory flag on Cloudflare (it dies with the activation), a status read
before an `await`, a broadcast (clients are not the store).

## Review checklist

For any change under `src/session/*` or `src/sandbox/lifecycle/*` that adds or moves an `await`:

- [ ] Name every repository read before the await whose value a write after the await depends on.
- [ ] For each, either move the read after the await (same continuation as the write) or make the
      write conditional and handle the "did not apply" branch.
- [ ] If the write is idempotent, say so in a comment at the site.
- [ ] Add the site to the audit table below with its classification.

CONTRIBUTING.md carries the one-line version of this checklist.

## Audit (2026-09-04)

Every read → `await` → dependent-write sequence in the six files the roadmap names, classified:

- **(a)** guarded: same continuation, or a conditional statement with a changes check
- **(b)** idempotent: safe to repeat or to lose to a later writer
- **(c)** unguarded: a concrete interleaving produces a wrong state; fixed by the PR named

"In-memory" means the guard is a per-runtime flag or claim, valid under rule 5 and, on Cloudflare,
only within one activation.

### `src/session/message-queue.ts`

| Site                                                                   | Sequence                                                                                                                                   | Class   | Note                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enqueuePromptCore` promptability check → `await fingerprintWebPrompt` | session status read → hash await → idempotency read, capacity, insert, `transition("active")`                                              | (c)     | A cancel or archive landing during the hash left the insert and the `active` transition unguarded: the closed session accepted a message and flipped back to `active`. Fix: the check moves after the await (PR 2).             |
| `enqueuePromptCore` insert → `transition("active")`                    | insert → transition reads and writes the session in the same turn                                                                          | (a)     | Same continuation.                                                                                                                                                                                                              |
| `handlePromptMessage` / `enqueuePromptFromApi` pre-checks              | promptable + capacity checks → participant writes → `enqueuePromptCore`                                                                    | (a)     | Same continuation up to the core's own check. The API path passes no `clientRequestId`, so it never awaits before the insert.                                                                                                   |
| `redrivePendingAutofix`                                                | message status + session reads → `transition("active")` → `processMessageQueue`                                                            | (a)     | Same continuation; the queue re-reads.                                                                                                                                                                                          |
| `processMessageQueue` dispatch                                         | session, awaiting-stop, processing, next-pending reads → `await getProviderAuthenticationError` → `failMessage` / `startMessageProcessing` | (a)     | `startMessageProcessing` is the #1479 claim (`status='pending' AND NOT EXISTS processing`); `recordMessageCompletion` takes the expected status. A cancel during the await fails the pending row, so the claim is lost cleanly. |
| `processMessageQueue` after send                                       | send fails → `updateMessageToPending`; send ok → `updateLastActivity(now)`                                                                 | (a)/(b) | `updateMessageToPending` is `WHERE status='processing'`. `now` was read before the auth await; a heartbeat may have written a later value. Idempotent; the inactivity window is shorter by the await's duration.                |
| `stopExecution`                                                        | processing read → `failMessage` → `markMessageAwaitingStopConfirmation` → `await schedule` → `await reconcileAfterExecution`               | (a)     | The failure is a conditional completion; the deadline write is in the same turn. The reconcile after the (storage) await is covered by PR 3.                                                                                    |
| `recoverStopConfirmationTimeout` → `resumeAfterSandboxTermination`     | awaiting-stop read → `await terminateUnresponsiveSandbox` → re-read → `clearMessageAwaitingStopConfirmation(id)`                           | (b)     | Clears by id; no other path sets a deadline while one is pending.                                                                                                                                                               |
| `handleFatalSandboxFailure`                                            | `terminateFailedSandbox` (sync writes, then provider await) ‖ `failStuckProcessingMessage`                                                 | (a)     | Conditional completion; in-memory `isTerminatingSandbox`.                                                                                                                                                                       |
| `cancelQueuedPrompt`                                                   | `cancelPendingMessage` → `reconcileAfterQueueRemoval`                                                                                      | (a)     | The repository transaction re-reads status and deletes `WHERE status='pending'`; reconcile runs in the same turn.                                                                                                               |
| `failStuckProcessingMessage`, `cancelExecution`, `enqueueAutofix`      | reads → conditional completions / `admitAutofixMessage` transaction                                                                        | (a)     | All synchronous up to the projection awaits.                                                                                                                                                                                    |

### `src/session/sandbox-events/processor.ts` and `execution.handler.ts`

| Site                                               | Sequence                                                                                                                                      | Class | Note                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `processSandboxEvent` → `handleExecutionComplete`  | processing-message read → `recordMessageCompletion(event, now, "processing")`                                                                 | (a)   | The context is read and the conditional completion applied in one continuation; `execution_complete` for a message no longer processing takes the `already_stopped` branch.                                                                                                                        |
| `handleExecutionComplete` after completion         | completion → `await projectTerminalMessage` (D1) → broadcasts → `await reconcileAfterExecution` → `transition(completed \| failed \| active)` | (c)   | An archive (allowed: no unfinished messages remain) or cancel landing during the projection await was overwritten: reconcile derived `completed`/`failed` from message state and `transition` wrote it over `archived`/`cancelled`. Fix: reconcile leaves a session that is no longer live (PR 3). |
| `handleExecutionComplete` `already_stopped` branch | `clearMessageAwaitingStopConfirmation(event.messageId)`                                                                                       | (b)   | Clear by id.                                                                                                                                                                                                                                                                                       |
| `handleExecutionComplete` tail                     | `updateLastActivity(context.now)` → `await scheduleInactivityCheck` → `processMessageQueue`                                                   | (b)   | Timestamp from the event's context; the queue re-reads everything.                                                                                                                                                                                                                                 |

### `src/session/session-status-service.ts`

| Site                                                    | Sequence                                                                                       | Class | Note                                                                                                                                                                                                                              |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transition`                                            | session read → `updateSessionStatus` → `await` index `updateStatus` → `finalizeChildAdmission` | (a)   | Local write in the read's continuation. The index write carries `WHERE updated_at <= ?`; the admission-lease delete is idempotent. `transition` itself does not check the current status: every caller reads it in the same turn. |
| `transition` same-status branch                         | `await` index `updateStatus` → metrics                                                         | (a)   | Fenced as above.                                                                                                                                                                                                                  |
| `repairIndexStatus`                                     | session read → `await repairStatus` → `finalizeChildAdmission`                                 | (a)   | `repairStatus` is `WHERE status = 'created'`.                                                                                                                                                                                     |
| `cancel`                                                | session read → status write → terminalize messages → projection                                | (a)   | Both mutations before the first await, as its contract states.                                                                                                                                                                    |
| `reconcileAfterExecution`, `reconcileAfterQueueRemoval` | message-count reads → `transition`                                                             | (c)   | The reads are fresh, but the decision ignored `cancelled`/`archived`, so a reconcile reached after an await (row above) moved a closed session. Fix: both return without transitioning when the session is no longer live (PR 3). |
| `settleFromMessageState`                                | message-count reads → `transition`                                                             | (a)   | Same continuation. Deliberately not guarded like the reconciles: it is the unarchive path and must leave `archived`.                                                                                                              |
| `syncSessionMetrics`                                    | four local reads → background index `updateMetrics`                                            | (b)   | Unfenced overwrite; each settled turn recomputes from the whole store, so a stale landing is corrected by the next one.                                                                                                           |

### `src/session/alarm/handler.ts`

| Site                       | Sequence                                                                                                                          | Class | Note                                                                  |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----- | --------------------------------------------------------------------- |
| `handle` execution timeout | `await flushPending` → `await recoverStopConfirmationTimeout` → processing read → `failStuckProcessingMessage` / `await schedule` | (a)   | The read follows the awaits; the failure is a conditional completion. |
| `handle` lifecycle         | `await lifecycleManager.handleAlarm()` → `failStuckProcessingMessage` → `resumeAfterSandboxTermination`                           | (a)   | Conditional completion; the resume clears by id and re-reads.         |

### `src/session/pull-request-service.ts`

| Site                                  | Sequence                                                                                           | Class | Note                                                                                                                            |
| ------------------------------------- | -------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------- |
| `createPullRequest` admission         | session + repository reads → `claims.claim(repo)`                                                  | (a)   | In-memory claim per target repository, taken before the first await; one creation per repository at a time. Valid under rule 5. |
| `createPullRequest` branch writes     | `listArtifacts` → provider awaits → push → `updateSessionRepositoryBranch` / `updateSessionBranch` | (b)   | Values derive from the request, not the read; the pre-await comparison only skips a redundant write.                            |
| `createPullRequest` artifact + record | provider `createPullRequest` → `createArtifact` (new id) → `await` D1 upsert                       | (a)   | Insert of a fresh id under the claim; the D1 upsert carries its monotonic `provider_updated_at` guard.                          |
| `applyLiveSnapshot`                   | `await` D1 upsert → re-read artifact → staleness check → `updateArtifact`                          | (a)   | The apply-time re-read is the pattern: authority first, then a guarded mirror write in the re-read's continuation.              |

### `src/sandbox/lifecycle/manager.ts`

| Site                                                                       | Sequence                                                                                                                          | Class | Note                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spawnSandbox` → `doSpawn` / `restoreFromSnapshot` / `resumeSandbox` entry | circuit-breaker + sandbox reads → decision → `isSpawningSandbox = true` → `enterProviderStartup` persists `spawning`/`connecting` | (a)   | Same continuation from the read to the persisted status; `enterProviderStartup` writes before its alarm await. In-memory flag for the rest of the attempt.                                                                                                                                                                                                                                         |
| `reserveSpawnIdentity`                                                     | reservation write → `await hashToken` → `updateSandboxAuthTokenHash(expectedSandboxId)`                                           | (a)   | #1606: the hash applies `WHERE modal_sandbox_id = ?`; a superseded attempt abandons without failure writes.                                                                                                                                                                                                                                                                                        |
| `stopPriorProviderSandbox`                                                 | object-id read → `await stop` → `updateSandboxModalObjectId(null)`                                                                | (a)   | Only spawn paths write the object id, and they hold the in-memory flag.                                                                                                                                                                                                                                                                                                                            |
| provider result writes (`doSpawn`, `restoreFromSnapshot`, `resumeSandbox`) | provider await → object id, access URLs, tunnel URLs, `storeTtyd` (`await mintJwt` → write)                                       | (b)   | They describe the provider-side sandbox that now exists and are what a later stop needs, whatever status the row reached meanwhile.                                                                                                                                                                                                                                                                |
| `finishProviderStartup`                                                    | provider await → socket / status read → `updateSandboxStatus("connecting")`                                                       | (c)   | A provider call longer than the connecting timeout lets the alarm mark the row `failed` (or a connected-then-dead bridge mark it `stale`); the late return overwrote that with `connecting` and broadcast it. Fix: advance only from `spawning` (PR 4).                                                                                                                                            |
| failure branches (`doSpawn` catch, restore failure, `resumeSandbox` catch) | provider await → `incrementCircuitBreakerFailure` → `updateSandboxStatus("failed")` → `reportSandboxError`                        | (c)   | A bridge that connected during the provider call set the row `ready` and attached its socket; a provider error after that (a post-create timeout) marked the working sandbox `failed`, which the alarm treats as dead and stops monitoring. Fix: fail only from the attempt's own `spawning`/`connecting` status (PR 4). The circuit-breaker increment stays unconditional: it counts the attempt. |
| `triggerSnapshot`                                                          | sandbox read → `snapshotting` → `await takeSnapshot` → `updateSandboxSnapshotImageId` → `updateSandboxStatus(previousStatus)`     | (c)   | A cancel, heartbeat-stale alarm, or unresponsive-sandbox termination during the snapshot set `stopped`/`stale`, cleared access, and detached the socket; the snapshot's return restored the pre-snapshot `ready`, so the spawn decision waited for a reconnect that cannot come. Fix: restore only from `snapshotting` (PR 4). The image stamp is idempotent metadata (last writer wins).          |
| `handleAlarm` branches                                                     | sandbox read → decision → status write + access clears → provider stop / `await triggerSnapshot` → detach                         | (a)   | Status and access writes precede the awaits; a snapshot taken with a terminal status does not restore it. Between the `stopped` write and the detach the still-attached socket can take one more dispatch; the same alarm turn fails and re-dispatches it (`failStuckProcessingMessage`, `resumeAfterSandboxTermination`).                                                                         |
| `terminateUnresponsiveSandbox`, `terminateFailedSandbox`                   | sandbox read → status + access writes → detach → `await stop`                                                                     | (a)   | Writes in the read's continuation; `isTerminatingSandbox` in memory.                                                                                                                                                                                                                                                                                                                               |
| `warmSandbox`                                                              | sandbox read → `spawnSandbox`                                                                                                     | (a)   | Same continuation into the reservation.                                                                                                                                                                                                                                                                                                                                                            |
| `lookupImageBuildForSpawn`, `markImageBuildRestoreFailed`                  | D1 image-build rows                                                                                                               | —     | Global store, outside the session core; the image-build state machine owns its own guards.                                                                                                                                                                                                                                                                                                         |

Three (c) classes, four fix sites, all behavior-preserving on Cloudflare outside the interleavings
they close:

- PR 2: `enqueuePromptCore` re-checks promptability after the fingerprint await.
- PR 3: `reconcileAfterExecution` and `reconcileAfterQueueRemoval` leave a session that is no longer
  live.
- PR 4: `SandboxStorage.transitionSandboxStatus(from, to)` (a conditional update returning whether
  it applied) replaces the unconditional status writes that follow a provider await: snapshot
  restore, provider-startup completion, and the attempt failure branches.

### Fold inventory

Sections that make two or more repository calls between a read and a dependent write. Each is a
candidate to become one atomic repository operation; that is the prerequisite for the post-October
async-repository engine (epic E8, COL-129), where the same-continuation guard stops existing and
only the conditional-statement form survives.

| #   | Section                                                                             | Calls between read and dependent write                                                                         | Folded operation                                                                                          |
| --- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| F1  | `enqueuePromptCore`                                                                 | idempotency lookup, unfinished count, attachment resolution + claim, insert, status transition, position count | `admitPrompt(request)`; `admitAutofixMessage` is the existing model                                       |
| F2  | `processMessageQueue` dispatch                                                      | awaiting-stop, processing, next-pending, author reads, claim + event insert                                    | `claimNextPrompt()` returning the claimed row with its author                                             |
| F3  | `stopExecution`                                                                     | processing read, conditional completion, stop-confirmation deadline                                            | `stopProcessingMessage(now, deadline)`                                                                    |
| F4  | `SessionStatusService.transition`                                                   | session read, unconditional status write                                                                       | `updateSessionStatusFrom(observed, next)` (compare-and-set)                                               |
| F5  | `reconcileAfterExecution` / `reconcileAfterQueueRemoval` / `settleFromMessageState` | unfinished count, latest terminal message, session read, status write                                          | `settleSessionStatus(outcome)`                                                                            |
| F6  | `triggerSnapshot`                                                                   | sandbox read, `snapshotting` write, image stamp, status restore                                                | `beginSnapshot()` / `completeSnapshot(imageId)` compare-and-set pair (PR 4 makes the restore conditional) |
| F7  | `reserveSpawnIdentity`                                                              | reservation, hash publication                                                                                  | Already two-phase by design (#1606); keep                                                                 |
| F8  | `handleAlarm` termination branches                                                  | sandbox read, status write, four access clears, tunnel clear                                                   | `retireSandbox(status)`                                                                                   |
| F9  | `createPullRequest`                                                                 | session + repository reads, branch writes, artifact insert, D1 record                                          | Store-backed creation claim replaces the in-memory one once rule 5 is relaxed                             |
| F10 | `applyPullRequestSnapshot`                                                          | D1 upsert, artifact re-read, staleness check, artifact update                                                  | Already the conditional pattern; becomes one operation under async repositories                           |
| F11 | `connection-authenticator.attachSandbox`                                            | last activity, heartbeat, socket accept, `ready` status                                                        | `publishSandboxReady(now)`                                                                                |
| F12 | `syncSessionMetrics`                                                                | message count, active duration, artifact list, session cost → one index write                                  | Already one write; add an `updated_at` fence when the index moves engines                                 |

## Related

- ADR 0003 (session snapshot handoff) applies rule 2 to the subscribe path: the snapshot read and
  the socket registration happen with no `await` between them.
- #1479 (prompt claim), #1606 (spawn admission), and the sandbox handshake in
  `connection-authenticator.ts` are the reference implementations of the guard forms.
- The roadmap items: H-3 (this document, COL-99), H-2 (the registry, COL-98), E8 (async
  repositories, COL-129).
