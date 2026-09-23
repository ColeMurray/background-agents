# Sandbox checkpoint and graceful shutdown before provider expiry

- **Status:** Implemented locally; automated verification complete, provider-backed release canaries
  required.
- **Date:** 2026-09-19
- **Issue:**
  [#1935 — Modal snapshot lost data](https://github.com/ColeMurray/background-agents/issues/1935)
- **Researched baseline:** public `main`, commit `222f1c002f1ba9ff7624090e1424b7e556b772f6`.

## 1. Decision summary

The Control Plane will schedule a **checkpoint-and-shutdown operation** before a Sandbox's actual
provider deadline. The operation closes admission to the current generation, halts an active prompt,
preserves the filesystem through the provider's supported mechanism, durably records the recovery
point, and retires the old running Sandbox. It is independent of browser presence and per-prompt
timeouts.

Users configure **Final snapshot buffer** in the existing Sandbox settings UI. This is the entire
time reserved before expiry for stopping execution, creating or confirming the recovery point, and
retiring the Sandbox—not just the duration of the snapshot API call.

“Final snapshot” is the product label. **Graceful shutdown** can produce two kinds of recovery
point:

- An independent filesystem snapshot/checkpoint for Modal, Vercel, and OpenComputer.
- A verified retained, stopped/paused Sandbox for E2B and Daytona, where this is the existing
  persistence contract. These are not represented as fabricated image IDs.

Use Modal's existing explicit filesystem snapshot API. Do not enable experimental exit snapshots,
experimental memory snapshots, or provider-managed automatic snapshotting as the coordinator. Modal
documents its [exit snapshot API as experimental](https://modal.com/docs/sdk/js/latest/Sandbox);
that API is not a dependency of this design.

For Daytona, preserve its current absence of a fixed provider lifetime. Do not introduce an
application-enforced lifetime merely to make the providers look alike. Its existing inactivity stop
uses the same stop-and-preserve contract; a pre-expiry alarm applies if its provider contract later
supplies a finite deadline. This is an explicit product decision, not an unsupported-provider skip.

## 2. Problem, evidence, and scope

The issue reports work missing after restoration. The supplied logs show an execution-complete
snapshot starting around the provider timeout and failing while the Sandbox shut down. Later
comments report recovering data from another logged snapshot ID. These reports motivate preserving
state before expiry; they do not establish that every missing-context incident has this cause.
[Issue and discussion](https://github.com/ColeMurray/background-agents/issues/1935).

Current source independently confirms the scheduling gap:

| Current behavior                                                                                        | Consequence                                                                                    | Evidence at the researched commit                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lifecycle alarms check connecting, heartbeat, boot, and inactivity limits, but not provider lifetime.   | A healthy, busy Sandbox can reach provider expiry without a checkpoint-and-shutdown operation. | [Lifecycle alarm handling](https://github.com/ColeMurray/background-agents/blob/222f1c002f1ba9ff7624090e1424b7e556b772f6/packages/control-plane/src/sandbox/lifecycle/manager.ts#L1485)                                                                                                                                                                         |
| Browser clients can extend inactivity.                                                                  | Inactivity is not a provider-expiry safety mechanism.                                          | [Inactivity decisions](https://github.com/ColeMurray/background-agents/blob/222f1c002f1ba9ff7624090e1424b7e556b772f6/packages/control-plane/src/sandbox/lifecycle/decisions.ts#L460)                                                                                                                                                                            |
| The runtime subtracts a reserve from each prompt's budget; each prompt receives a fresh clock.          | The reserve does not track accumulated Sandbox uptime.                                         | [Prompt budgets](https://github.com/ColeMurray/background-agents/blob/222f1c002f1ba9ff7624090e1424b7e556b772f6/packages/sandbox-runtime/src/sandbox_runtime/prompt_budgets.py#L64), [prompt receipt](https://github.com/ColeMurray/background-agents/blob/222f1c002f1ba9ff7624090e1424b7e556b772f6/packages/sandbox-runtime/src/sandbox_runtime/bridge.py#L863) |
| `triggerSnapshot()` returns `void`, logs errors, and restores the previous status.                      | Callers cannot distinguish preserved, failed, skipped, and unknown outcomes.                   | [Snapshot implementation](https://github.com/ColeMurray/background-agents/blob/222f1c002f1ba9ff7624090e1424b7e556b772f6/packages/control-plane/src/sandbox/lifecycle/manager.ts#L1268)                                                                                                                                                                          |
| Inactivity can announce “snapshot saved” without a successful result.                                   | Users can receive an incorrect assurance that state was saved.                                 | [Inactivity stop](https://github.com/ColeMurray/background-agents/blob/222f1c002f1ba9ff7624090e1424b7e556b772f6/packages/control-plane/src/sandbox/lifecycle/manager.ts#L1649)                                                                                                                                                                                  |
| Execution completion launches a background snapshot and pumps the prompt queue.                         | Final stopping needs its own durable admission fence and snapshot ownership.                   | [Execution handler](https://github.com/ColeMurray/background-agents/blob/222f1c002f1ba9ff7624090e1424b7e556b772f6/packages/control-plane/src/session/sandbox-events/execution.handler.ts#L124)                                                                                                                                                                  |
| `stop` cancels the prompt task without awaiting its completion; `snapshot` only emits `snapshot_ready`. | Neither command establishes that an active prompt and its tools have stopped.                  | [Bridge commands](https://github.com/ColeMurray/background-agents/blob/222f1c002f1ba9ff7624090e1424b7e556b772f6/packages/sandbox-runtime/src/sandbox_runtime/bridge.py#L1017)                                                                                                                                                                                   |
| `snapshot_saved`, `sandbox_warning`, and `sandbox_restored` do not produce durable web recovery state.  | A new broadcast alone will not solve visibility after reload.                                  | [Session reducer](https://github.com/ColeMurray/background-agents/blob/222f1c002f1ba9ff7624090e1424b7e556b772f6/packages/web/src/lib/session-socket/reducer.ts#L338)                                                                                                                                                                                            |

### Goals

1. Begin checkpoint and shutdown early enough to finish before a known provider cutoff under the
   tested operating budget.
2. Halt the active prompt before the normal final capture, and prevent another prompt or managed
   workspace mutation from starting on the retiring generation.
3. Preserve saved workspace files, including uncommitted/untracked files and sandbox-local agent
   state covered by that provider's persistence mechanism, across all five supported providers.
4. Survive Control Plane restart, duplicate alarms, reconnects, and ambiguous provider responses.
5. Never report checkpoint-and-shutdown success or silently restore an older recovery point after
   that operation failed.
6. Make the buffer configurable through existing global, repository, and environment settings.

### Non-goals and limits

- Reconstructing missing model conversation history from the Session Event Stream: this is separate
  from filesystem recovery and
  [issue #997](https://github.com/ColeMurray/background-agents/issues/997).
- Cross-provider artifact migration, arbitrary snapshot history/browsing, periodic backup policy,
  Git auto-commits, or changing ordinary connected-client inactivity policy.
- Preserving unsaved editor buffers, arbitrary process memory, external database transactions, or
  already-issued external side effects. An interrupted prompt is not safe to replay automatically.
- Promising losslessness during a provider outage, unexpected host loss, an unbounded filesystem
  capture, or a Control Plane outage longer than the reserve. The design gives a measurable
  pre-expiry protocol and an honest degraded outcome, not a backup SLA.
- Bypassing the runtime compatibility floor. An incompatible retained image must be reported as
  recovery-required, not discarded and replaced with a fresh checkout without notice.
- Stopping unrelated editors, terminals, VNC, or background services to establish whole-workspace
  quiescence. This feature confirms active prompt/tool stopping, not arbitrary application
  consistency.
- A new successful-resume product workflow, provider-side result journals, or a separate
  lease-renewal and clock-synchronization protocol.

## 3. Provider behavior and required adaptations

The common policy must use provider receipts, not a provider-name switch scattered through Session
code or the existing booleans alone.

| Provider         | Current implementation                                                                                                                                         | Checkpoint and shutdown                                                                                                                                                                          | Deadline source                                                                                                                                                             |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Modal**        | Two-hour default passed to create; explicit filesystem snapshot; image restore. No session explicit-stop capability.                                           | Stop prompt → explicit filesystem snapshot → commit ready image → authenticated provider termination. Add a narrow stop endpoint; runtime shutdown remains a courtesy, not proof of termination. | Provider timing if available; otherwise a conservative timestamp immediately **before** provider create plus its accepted duration. Return it from both create and restore. |
| **Vercel**       | Adapter caps lifetime at 45 minutes. Snapshot/restore supported.                                                                                               | Stop prompt → snapshot, which itself stops the source → commit ready image and stopped result. Do not wait for an acknowledgement from a runtime already stopped by snapshotting.                | Normalize provider `session.createdAt` and accepted `session.timeout`; account for the adapter cap.                                                                         |
| **E2B**          | Session snapshots intentionally unsupported. Stop pauses; resume reconnects the retained object and can change its timeout.                                    | Stop prompt → explicit pause → verify paused/retained → commit retained-object receipt. Never use the destructive kill branch as successful state capture.                                       | Parse provider detail `endAt` after create, connect, and timeout mutation. A reconnect is not itself evidence of a renewed lease.                                           |
| **Daytona**      | No hard-TTL capability; inactivity auto-stop/archive; stop/start retains filesystem.                                                                           | At an existing stop boundary: stop prompt if necessary → stop → verify stopped/retained → commit retained-object receipt. Do not use the respawn/delete branch.                                  | Explicit `none` today. `timeoutSeconds` used for preview access is not a Sandbox deadline.                                                                                  |
| **OpenComputer** | Baseline uses checkpoint/fork plus hibernate/wake and accepts `processing` snapshots. Current v2 has a hard host lifetime and in-place checkpoint restoration. | Stop prompt → disk checkpoint → poll until restorable → commit independent artifact → retire source. Restore into a fresh target before starting its runtime.                                    | Provider `endAt`, including time already consumed by the warm-pool host. Never infer it from client creation time or rolling idle timeout. Missing metadata is `unknown`.   |

Current adapter evidence:
[Modal](https://github.com/ColeMurray/background-agents/blob/222f1c002f1ba9ff7624090e1424b7e556b772f6/packages/control-plane/src/sandbox/providers/modal-provider.ts#L89),
[Vercel](https://github.com/ColeMurray/background-agents/blob/222f1c002f1ba9ff7624090e1424b7e556b772f6/packages/control-plane/src/sandbox/providers/vercel/provider.ts#L57),
[E2B](https://github.com/ColeMurray/background-agents/blob/222f1c002f1ba9ff7624090e1424b7e556b772f6/packages/control-plane/src/sandbox/providers/e2b-provider.ts#L176),
[Daytona](https://github.com/ColeMurray/background-agents/blob/222f1c002f1ba9ff7624090e1424b7e556b772f6/packages/control-plane/src/sandbox/providers/daytona-provider.ts#L85),
[OpenComputer](https://github.com/ColeMurray/background-agents/blob/222f1c002f1ba9ff7624090e1424b7e556b772f6/packages/control-plane/src/sandbox/providers/opencomputer-provider.ts#L233).

Provider documentation confirms that
[Vercel snapshots stop the source](https://vercel.com/docs/sandbox/concepts/snapshots),
[E2B pause preserves a resumable Sandbox](https://docs.e2b.dev/sandbox/persistence), and
[Daytona stop/start preserves persistent filesystem state](https://www.daytona.io/docs/en/persistence/).
These mechanisms have different semantics but satisfy the common recovery contract when verified.

**OpenComputer compatibility work is required, not deferred out of scope.** Re-verification on
2026-09-19 found that current v2 guides supersede older overview/API pages: every sandbox has an
eight-hour maximum host lifetime, including time spent hibernated or in the warm pool. Its returned
`endAt` is authoritative; adding eight hours to client-side creation time would be unsafe. Missing
`endAt` holds admission as unknown, rather than assuming the retired v1 contract. V2 does not
support checkpoint fork/create-from-checkpoint, so session restoration and prebuilt-image launch
create a fresh target, wait for readiness, restore the checkpoint in place, refresh provider
metadata, and only then start the runtime. Checkpoints outlive their source; the shutdown
coordinator polls until the exact artifact is ready before publication.
[Lifetime](https://docs.opencomputer.dev/sandboxes/lifetime),
[v1 migration](https://docs.opencomputer.dev/migrating-from-v1),
[checkpoints](https://docs.opencomputer.dev/sandboxes/checkpoints), and
[restore API](https://docs.opencomputer.dev/api-reference/checkpoints/restore).

Snapshot expiry is also independent of source Sandbox expiry; this feature does not add retention
management. The baseline pins Modal 1.4.3; newer documentation changes the filesystem-snapshot
default retention. Do not propagate the existing “persists indefinitely” comments as a general
guarantee. [Modal retention](https://modal.com/docs/guide/sandbox-snapshots).

## 4. Configuration

Add optional `finalSnapshotBufferMs` to existing `SandboxSettings`, not a separate settings service.
The web UI labels it **Final snapshot buffer (minutes)**; storage and TypeScript use milliseconds,
provider/runtime calls convert explicitly to seconds where required.

- Default: **600,000 ms (10 minutes)**.
- Minimum: **300,000 ms (5 minutes)**, in whole seconds.
- An explicitly configured buffer must be smaller than an explicitly configured lifetime.
- Timing validation uses the inherited buffer or `DEFAULT_FINAL_SNAPSHOT_BUFFER_MS` when no buffer
  is explicitly configured. There is no exemption for unchanged or previously stored timeouts.
  Stored settings use the existing invalid-value normalization; writes reject invalid timing.
- Resolve through the existing global → primary-repository → environment settings composition.
  Repository-less sessions use the existing global/environment path.
- Child sessions inherit the parent's resolved lifetime/buffer pair rather than accidentally
  combining a parent's lifetime with a different repository's reserve.
- Session settings are captured at launch. Editing dashboard defaults does not renew an existing
  provider lease or change a generation already shutting down.
- Do not silently shrink the safety reserve to fit a short lifetime: a new generation already inside
  its drain boundary begins graceful shutdown without dispatching a prompt. If the remaining phase
  budgets do not fit, surface failure. Users should select a lifetime longer than the buffer.
- A provider may cap the requested lifetime. Scheduling always uses its returned effective deadline,
  not the dashboard request. This matters for Vercel's current adapter cap.
- The setting does not create a fixed lifetime for Daytona. Its existing inactivity stop uses the
  same checkpoint-and-shutdown procedure.

## 5. Deadlines and durable ownership

Reuse the existing generation identity:

```ts
type SandboxGeneration = { sandboxId: string; createdAt: number };

type SandboxLifetime =
  | {
      kind: "finite";
      expiresAtMs: number;
      observedAtMs: number;
      source: "provider" | "conservative_start_bound";
    }
  | { kind: "none"; observedAtMs: number }
  | { kind: "unknown"; observedAtMs: number; reason: string };
```

Generation creation time is an ownership fence, not a claim about provider expiry. In-place resume
receives a new generation and a new lifetime receipt. Missing expiry is not equivalent to a
documented absence of fixed expiry.

For a finite deadline `D`, start draining at `D - finalSnapshotBufferMs`. Browser presence,
heartbeats, and prompt completion cannot extend that boundary.

The phase budgets have fixed upper bounds; capture time shrinks to fit the remaining buffer:

| Phase                                  | Maximum budget |
| -------------------------------------- | -------------- |
| Confirm active prompt/tool stop        | 60 seconds     |
| Capture or retained-state confirmation | 300 seconds    |
| Confirm separate source retirement     | 30 seconds     |
| Reserve before the hard cutoff         | 30 seconds     |

At entry, clamp each absolute phase deadline to the provider cutoff. A late alarm cannot restart a
full relative budget beyond `D`. At the five-minute floor, reserve 60 seconds for stopping, up to
180 seconds for capture, 30 seconds for retirement, and 30 seconds of safety margin. Larger buffers
retain up to 300 seconds for capture; the ten-minute default is unchanged. A late alarm further
reduces the capture window rather than moving the provider cutoff. Provider calls receive both an
absolute deadline and an abort signal; the coordinator also bounds its wait. An HTTP cancellation is
not proof that a remote side effect rolled back.

Use the existing earliest-deadline alarm scheduler, shared by Cloudflare and Node hosts. Check
shutdown before generic execution/heartbeat cleanup and before slow index projection I/O, and
reassert the finite boundary on every earlier alarm. Independently check the absolute boundary in
prompt admission, including after asynchronous credential lookup and immediately before
claiming/sending a prompt.

Persist one validated `sandbox_preservation` singleton in the Session SQLite database:

- Generation, provider object locator, lifetime kind and provenance, expiry and drain boundary.
- Runtime protocol support and matching generation acknowledgement.
- Phase, operation ID, interrupted message ID, durable continuation pause, absolute phase deadlines.
- Ordinary-checkpoint in-flight marker.
- Latest verified recovery receipt and safe failure description.

A receipt contains provider ownership, artifact locator, kind (`snapshot` or `retained`), runtime
version, and last successful save time. Do not expose locators or credentials through the public
Session projection. Retained E2B/Daytona objects are mutable on resume: their timestamps are not
promises of an immutable historical rollback point.

The durable phases are:

```text
running → draining → prepared → capturing → retiring → saved
              \________ failures / uncertain outcomes ______/
                              failed / unknown
```

No separate lease epoch, distributed service, provider-side journal, or clock-synchronization
protocol is required.

## 6. Runtime preparation and prompt settlement

New runtimes advertise `preservationProtocolVersion: 1` in `ready`. Before dispatch, the Control
Plane sends `sandbox_generation`; the runtime returns critical/replayable `sandbox_generation_ready`
with the identical generation. A same-generation reconnect does not clear the runtime's shutdown
fence. Only a new authenticated generation may clear it. This is essential when E2B resumes frozen
process memory.

At the boundary:

1. In one synchronous Session transaction, claim an operation, persist `draining`, and terminalize
   the current processing message through the existing message-failure machinery. At hard expiry its
   reason is `sandbox_lifetime_expiring`. A natural completion committed before that transaction
   remains completed. Never infer order from runtime timestamps.
2. Publish the interrupted result and reconcile status/callbacks asynchronously. These awaits do not
   delay the fence. Pending messages stay pending; the interrupted prompt is never automatically
   replayed.
3. Send the existing authenticated sandbox socket:
   ```ts
   const command = {
     type: "prepare_preservation",
     operationId,
     generation,
     messageId, // optional for shutdown between prompts
     stopByMs,
   };
   ```
4. The bridge closes prompt/push/managed-refresh admission before awaiting anything. It contains the
   active harness execution under that single deadline, cancels/joins the prompt task, and persists
   its rotated sandbox-local session identifier.
   - **Claude:** request interrupt, then await the SDK-owned child disconnect. A disconnect
     exception or timeout is not stop evidence; retain the handle for retry.
   - **OpenCode:** request abort and independently poll the vendor session until idle. An abort HTTP
     acknowledgement alone is not proof.
   - Confirm harness stopping even when the bridge task has already finished or been cancelled by a
     normal Stop action; task completion alone is not proof that vendor tools are idle.
5. Emit critical/replayable `preservation_prepared` with operation ID, generation,
   `executionStopped`, and an optional safe error. The Control Plane persists matching preparation
   evidence before ACK. Ignore stale generations and operation IDs.
6. Duplicate preparation replays the cached result. A user-approved retry of a completed,
   unsuccessful preparation may use a new operation without reopening admission. In-flight
   preparations cannot overlap.

Stop only the active prompt and its tools. Do not stop editors, terminals, VNC, or unrelated
background services, or introduce a general supervisor drain/restart framework. The capture has
native provider filesystem consistency, not arbitrary application consistency. Unsaved buffers,
external side effects, and writes after the capture point are outside the guarantee.

If execution stopping cannot be confirmed, this implementation fails closed rather than taking an
unlabelled crash-consistent snapshot. No degraded-capture subsystem is required.

## 7. Checkpoint capture, retirement, and normal continuation

Select the persistence mechanism from provider capabilities:

- Providers supporting filesystem snapshots (Modal, Vercel, OpenComputer) create an independent
  recovery artifact. OpenComputer must poll its checkpoint collection until the artifact is ready; a
  `processing` ID is not success.
- Persistent-resume providers without session snapshots (E2B, Daytona) use explicit
  `intent: "preserve"` stop/pause and verify retained state. A missing object cannot produce a
  retained receipt. E2B pause conflicts must be reconciled as actually paused.

Do not fabricate image IDs for retained objects. Do not select a mechanism solely from whether a
provider has a hard deadline.

After verifying the recovery point, commit the receipt before a separately destructive retirement.
For independent artifacts, use typed `intent: "destroy"` to retire the captured source only; for
retained objects, keep the object. Reasons remain diagnostics, not the new intent contract. Vercel
snapshots and E2B pauses end execution as part of capture; their confirmed stop result avoids an
unnecessary second stop.

Generation and operation checks guard late results and publication. Keep the previous receipt until
a new one is verified. Ordinary non-destructive snapshots share the capture gate and cannot
overwrite a newer generation's recovery state. If one is already in flight, fence new work and await
its bounded completion before sending final preparation and taking the final capture. It does not
count as the final snapshot merely because it completed recently.

Vercel's ordinary execution-complete snapshot is destructive, so route it through the same
preparation/retirement flow. Other ordinary snapshots retain their existing trigger, with the shared
gate.

Only after receipt commit **and** confirmed source retirement:

- Mark the Sandbox stopped, revoke live access URLs, and detach its socket.
- Persist/publish `saved`.
- If the shutdown interrupted an active prompt, hold later prompts until the user explicitly resumes
  queued work. Never replay the interrupted prompt automatically.
- If shutdown reaches a clean prompt boundary, continue queued/new work automatically.
- Prefer the explicit final receipt over an older snapshot or persistent-source heuristic.
- Require compatible runtime version and matching provider ownership.
- Never silently fresh-spawn if this restore/resume fails.

A new generation must again publish lifetime metadata and complete the runtime handshake. This
prevents E2B's retained preparation fence from rejecting the next prompt and prevents an expired
OpenComputer source from outranking its independent checkpoint.

## 8. Restarts, failures, and recovery

The SQLite record, not a background promise, owns the operation.

| Observation                                               | Behavior                                                                      |
| --------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Restart while draining                                    | Resend the same correlated preparation within its original deadline.          |
| Restart after preparation                                 | Continue capture using the durable stop evidence and deadline.                |
| Restart during capture / response lost                    | Persist `unknown`; do not blindly repeat capture or retire the source.        |
| Restart while retiring                                    | Reconcile/retry retirement of the exact source with the committed receipt.    |
| Stop deadline missed                                      | Persist `failed`; hold dispatch and retain the source/previous receipt.       |
| Provider returns pending artifact                         | Poll within the capture deadline; do not announce success.                    |
| Provider rejects, times out, or returns ambiguous failure | Persist `unknown`; adapters may wrap transport ambiguity in a failure result. |
| Capture succeeds but retirement is unconfirmed            | Keep the new receipt, publish `unknown`, and forbid overlapping replacement.  |
| Saved artifact/object missing or incompatible on restore  | Hold recovery; never replace it silently with a clean checkout.               |
| Old generation result arrives late                        | Ignore publication and status changes for the current generation.             |

Provider-native readiness/readback is used where available. A universal capture-result journal,
automatic artifact cleanup service, and arbitrary snapshot history browser are not prerequisites. An
unrecoverable response remains explicitly unknown.

Receipt availability is separate from proof that the **current** source is retired. Persist that
proof on verified retirement and carry it through restore preflight, then invalidate it before
calling the provider to restore or resume. A preflight failure keeps dispatch held but allows an
explicit saved-state retry without trying to retire a nonexistent target. A lost provider response
does not prove no new sandbox was started: retained-object resume keeps its known handle so recovery
can stop it again before retrying; snapshot restore with no returned handle remains unknown. Late
failures must match the attempted generation before changing recovery state.

Successful provider creation/resume must return an explicit lifetime receipt. If a trailing metadata
read fails after ownership was established, return the successful handle with an `unknown` lifetime,
not a failed startup that loses ownership. Unknown lifetime deliberately holds dispatch; running
without confirmed checkpoint-and-shutdown support is not a supported degraded mode for new launches.

The UI's recovery commands reuse authenticated Session WebSocket handling and existing lifecycle
permission:

- **Retry shutdown:** only from `failed`, where capture did not start. Keep admission closed and
  retry preparation with remaining time. Unknown capture cannot be retried blindly.
- **Restore saved state:** only when a verified receipt exists, after an explicit warning that
  changes since the last save may be lost. Confirm old execution ended, then let queued/new work use
  that receipt. Only authoritative provider expiry can independently prove the current source
  execution ended. A conservative request-start bound, or an older record without provenance, still
  requires verified retirement; proof for an earlier source does not cover a later restore.
- **Resume queued work:** only from `saved` when an active prompt was interrupted and a verified
  recovery point exists. Resume from that checkpoint without replaying the interrupted prompt.
- If no usable receipt/known source exists, retain the visible hold. Starting a separate session
  remains an existing user action, not an automatic data-loss fallback.

Generic stop-confirmation timeouts, execution-complete queue pumps, and lifecycle cleanup must not
override a shutdown-owned hold. Explicit session cancellation still cancels queued execution; it is
not a new promise of backup during unexpected teardown.

## 9. Web UI and protocol projection

Add optional `sandboxPreservation` to the canonical Session snapshot and a `sandbox_preservation`
semantic server message using the same shared schema.

These deployed wire fields, runtime protocol identifiers, and the `sandbox_preservation` SQLite
table retain their compatibility names. The shared `sandbox-shutdown` module exports
`SandboxShutdownState` and `sandboxShutdownSchema`; renaming these source symbols does not change
the serialized shape. Internal control-plane modules, runtime preparation, UI callbacks, and
user-facing wording use shutdown terminology instead. Runtime manifest keys, version strings,
generation values, and existing log-event identifiers remain unchanged by the naming cleanup.

The public view includes phase, reason, effective expiry/drain times, last successful save time,
safe error text, receipt existence, and server-authoritative `availableRecoveryActions`. Snapshot
and semantic updates use the same eligibility checks as command execution. A receipt belonging to
another provider is not an available restore action. The view excludes provider artifact IDs,
tokens, and private access credentials. Missing action metadata disables recovery controls.

The existing `recover_preservation` command accepts an optional `clientRequestId`. New clients await
a sender-only `shutdown_recovery_accepted` response or a correlated error and disable recovery
controls while pending. Acceptance confirms the request, not completed restoration. Disconnects and
timeouts surface an unconfirmed result and do not retry automatically; durable status remains the
source of truth. Legacy commands without an ID do not receive the new acknowledgement.

The reducer replaces this state from the initial/reconnect snapshot and applies semantic updates.
Show compact stopping/saving/retiring/saved banners and persistent failed/unknown warnings. When a
successful checkpoint interrupted an active prompt, explain that its partial work was saved, the
interrupted prompt will not replay automatically, and later prompts remain held behind an explicit
**Resume queued work** action. Clean successful shutdowns add no mandatory user step.

## 10. Implementation map

| Area                | Files / responsibility                                                                                                                                            |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Policy settings     | Shared integrations types; control-plane settings normalization, resolved settings, spawn context/children; web Sandbox settings draft/editor.                    |
| Provider boundary   | `sandbox/provider.ts`, five adapters and REST clients; actual lifetime receipts, deadline propagation, explicit stop intent, ready/retained verification.         |
| Modal               | Authenticated explicit stop endpoint; existing filesystem snapshot API bounded by the absolute deadline. No experimental snapshot APIs.                           |
| Coordinator         | `session/sandbox-shutdown.ts` and `sandbox-shutdown-repository.ts`; additive SQLite migration 54.                                                                 |
| Lifecycle           | `sandbox/lifecycle/manager.ts` and `shutdown-policy.ts`; admission, readiness, generation/lifetime publication, checkpoint ownership, recovery, watchdog fencing. |
| Session integration | Queue admission, earliest alarm handler, critical event processing, snapshot reader, existing authorized client-command route.                                    |
| Runtime             | Bridge generation/preparation protocol, critical event forwarding, Claude/OpenCode stop confirmation.                                                             |
| Web                 | Session socket reducer/hook and `SandboxShutdownBanner` with failure recovery and explicit resume after interruption.                                             |

The public repository worktree is the only implementation target. The production clone, deployments,
and GitHub issue state are unchanged; changes are delivered through a public-repository pull
request.

## 11. Verification and release boundary

Automated coverage must establish:

1. Settings units/defaults/minimum, scope inheritance, child lifetime/buffer inheritance, and
   consistent validation of explicit and omitted buffers.
2. Finite, no-deadline, and unknown lifetime handling; provider caps and resumed E2B `endAt`.
3. Absolute admission at drain, matching generation handshake, stale-event rejection, and
   deadline-bounded preparation.
4. Exactly-once interruption, held pending work, natural-completion ordering, ordinary/final
   snapshot exclusion, and suppression of generic destructive cleanup.
5. Ready artifact/retained-state proof; NotFound is not proof of saved state; source retirement only
   after receipt publication (or atomically with checkpoint capture).
6. Duplicate commands, control-plane restart in each phase, capture timeout, late results, explicit
   failure recovery, and no silent fresh fallback.
7. Durable reconnect UI state and lifecycle authorization for recovery.
8. Cloudflare/Workerd integration plus shared Node-compatible persistence/alarm abstractions.

Local automated tests and typechecks are necessary, not proof of deployed provider behavior. Before
production rollout, run a provider-backed canary for **each** of Modal, Vercel, E2B, Daytona, and
OpenComputer:

- Write tracked, untracked, ignored, and secondary-repository sentinels plus a manual saved edit.
- Start an active tool; trigger the finite drain or existing inactivity stop.
- Verify the interrupted prompt does not continue/replay and queued work does not overlap capture.
- Restore/resume and verify sentinels and sandbox-local harness state.
- Exercise both harness stop implementations and at least one lost-response failure.
- For OpenComputer, verify authoritative `endAt`, fresh-target in-place checkpoint restoration, and
  artifact survival after source retirement against the deployed v2 contract.
- Measure stop/capture/retirement latency against the 10-minute default and 5-minute minimum. Native
  retention policies remain provider-specific; this is not an indefinite-backup SLA.

Ship runtime protocol support and rebuild cached repository images before enabling the new Control
Plane for new launches. Runtime generation 71 raises the rebuild floor without raising the existing
snapshot compatibility floor or silently discarding older saved state. Existing active generations
without shutdown metadata remain legacy/unprotected until a new launch; do not fabricate an expiry
from deployment time. Eligible older snapshots and retained sandboxes remain restorable under legacy
lifecycle policy; they do not acquire confirmed-shutdown guarantees. A new launch selected for
confirmed shutdown that fails its protocol handshake remains visibly held.

Structured `sandbox.preservation` logs carry phase, provider, generation, operation ID and expiry.
Persisted warnings make uncertain outcomes visible after reload. Provider-backed canaries and
production deployment were not performed as part of local implementation.

## 12. Review decisions and scope

The independent design review identified four avoidable expansions. This implementation incorporates
the narrow alternatives:

- Explicit continuation after an active prompt is interrupted; clean successful shutdowns still need
  no acknowledgement.
- Active prompt/tool containment, not whole-workspace service shutdown.
- Honest persistent unknown outcomes, not mandatory provider-side result journals.
- Existing generation identity, not a second lease epoch or clock protocol.

The provider/runtime review additionally required retained-state readback, independent OpenComputer
checkpoints, a fresh authenticated generation on memory resume, ready-before-publication, and no
false success when an SDK disconnect or provider lookup fails.

Deferred deliberately: degraded captures without stop evidence, universal remote operation
reconciliation, automatic lease renewal, cross-provider recovery, snapshot history/retention
management, and unrelated service supervision changes.
