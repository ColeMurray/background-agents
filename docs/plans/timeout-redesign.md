# Turn Timeouts And Boot Readiness

Status: implementation specification, 2026-09-12. See [operator and rollout notes](../TIMEOUTS.md)
for implemented behavior, compatibility gates, and validation limits.

This proposal revises the design in "Turn and boot timeouts from first principles." It is based on
the current runtime, control-plane, provider, and image-build code. The recently shipped increase of
the bridge silence threshold to 300 seconds is a mitigation, not the intended Claude policy.

## Summary

Remove Claude's parsed-message silence timeout. Keep a scoped OpenCode event-stream responsiveness
timeout. Fix boot hooks to observe shell completion independently of inherited output descriptors.
Do not turn unfinished setup or required startup into success merely because a wait expired.

Separately, make execution deadlines and cancellation enforceable: use remaining provider lifetime
where known, retain one bounded cleanup allowance, and do not reuse a runtime while stopped work may
still be executing.

The central rule is:

> Observe completion directly, use health signals only for the component they describe, bound work
> with explicit budgets, and distinguish a failed message from execution that has actually stopped.

The immediate fixes can ship independently. They must not claim the stronger lifecycle guarantees
until the deadline and cancellation work is complete.

## Goals

- Allow healthy, quiet Claude turns to continue through thinking, tools, and sub-agent work.
- Detect broken harness communication without claiming to observe model progress.
- Bound total turn execution independently of request and tool timeouts.
- Prevent stopped or expired turns from overlapping subsequent work in the same runtime.
- Preserve background services launched by a successfully completed hook.
- Prevent incomplete provisioning from being published as a successful image.
- Preserve useful diagnostics without introducing unbounded or secret-bearing image artifacts.
- Describe exactly which existing images and snapshots receive the new behavior.

## Non-Goals

- A uniform heartbeat protocol across all harnesses.
- An external detector that proves a model or tool is making useful progress.
- New Claude transports or parsing undocumented CLI progress frames.
- A repository health-check or service-supervision API.
- Making every runtime hook optional or connecting the agent before repository preparation.
- A comprehensive timeout-settings UI or spend-budget system.
- Guaranteeing a completed snapshot after provider failure or exhausted provider lifetime.

## First Principles

### Evidence And Policy Are Separate

| Observation                   | What it establishes                           | What it does not establish                       |
| ----------------------------- | --------------------------------------------- | ------------------------------------------------ |
| Bridge heartbeat              | The bridge heartbeat path is responsive       | The harness or turn is progressing               |
| OpenCode event-stream traffic | The stream is delivering data                 | A particular model request will finish           |
| Child process exit            | That process exited                           | Every descendant or remote operation stopped     |
| Turn result                   | The harness reported a turn outcome           | A failed or cancelled turn has no remaining work |
| Hook shell exit               | The launch or initialization script completed | Its background services are healthy              |
| No user-visible output        | No output was observed during that interval   | The turn is dead or has exceeded its budget      |

Timeout-based health checks indicate suspected unresponsiveness, not proof of process death. Their
error messages and recovery actions must respect that limitation.

### Different Policies Need Different Clocks

| Policy                   | Owner                                      | Expiry action                                                                |
| ------------------------ | ------------------------------------------ | ---------------------------------------------------------------------------- |
| Component responsiveness | The component communicating with it        | Recover the connection or fail the operation and contain uncertain execution |
| Request or tool budget   | The harness or tool executor               | Cancel that request or tool according to its contract                        |
| Whole-turn budget        | Control plane, enforced locally by runtime | Initiate bounded cancellation; prevent unsafe runtime reuse                  |
| Sandbox lifetime         | Provider                                   | Provider-specific expiration; plan cleanup before it                         |
| Idle-session retention   | Control plane                              | Reap an unoccupied runtime according to session policy                       |
| Hook readiness wait      | Repository boot coordinator                | Apply the hook's required or best-effort policy                              |
| Quiet-turn notice        | Presentation layer                         | Inform the user; do not change execution state                               |

A parent may enforce an end-to-end budget even when every child operation has its own timeout.
Repeated successful retries or tools can exceed the parent's acceptable total duration.

### Stopping Observation Is Not Stopping Work

Cancelling a reader task, requesting interruption, and confirming execution has stopped are three
different operations. Message settlement and runtime availability must remain separate until the
system has enough evidence to release the runtime for more work.

Readiness is also a dependency contract. If later work requires successful setup, waiting long
enough does not satisfy that dependency. Cleanup after a failed readiness wait is an explicit
ownership policy, not something implied by the word "timeout."

## Current Behavior

Runtime implementations now live in `packages/sandbox-runtime`; Modal is one of several providers.
These are code-verified defaults and behaviors, not proposed guarantees.

| Area                       | Current behavior                                                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude silence             | Each read from `receive_messages()` has a 300-second default deadline, controlled by `BRIDGE_SSE_INACTIVITY_TIMEOUT`                                  |
| OpenCode silence           | The same threshold resets on consumed SSE chunks; the timeout also surrounds downstream processing                                                    |
| Turn duration              | Each turn receives configured sandbox duration minus a derived reserve; default values produce a 6,300-second turn allowance                          |
| Cleanup allowance          | `min(900 seconds, 25% of configured sandbox duration)`; not based on remaining provider lifetime                                                      |
| Runtime Stop               | Cancel the prompt task and call best-effort harness abort; completion reporting can precede abort completion                                          |
| Session execution watchdog | Resolves from persisted sandbox timeout, then `EXECUTION_TIMEOUT_MS`, then the shared two-hour default; expiry fails the message without sending Stop |
| Automation sweep           | Uses `EXECUTION_TIMEOUT_MS` or a separate 90-minute default, from an earlier run-start timestamp; can fail bookkeeping while execution continues      |
| Session inactivity         | Ten-minute default; bridge heartbeats refresh activity while a message is processing                                                                  |
| Initial connection         | 240-second watchdog, including time before the bridge connects                                                                                        |
| Setup hook                 | 300-second default; waits for captured output and process completion via `communicate()`                                                              |
| Start hook                 | 120-second default; uses the same output and cleanup path                                                                                             |
| Hook timeout               | Cancels the communication helper, which kills the owned process group                                                                                 |

`SANDBOX_TIMEOUT_SECONDS` is a relative launch configuration, not an authoritative expiry. Providers
differ: Vercel caps lifetime, E2B and OpenComputer can renew it on some resume paths, and Daytona
does not advertise this setting as a hard sandbox lifetime. The common provider interface does not
currently return a standardized execution-expiry deadline.

CLI request, stream, and tool timeout values are intentionally not enumerated here. Their actual
semantics, environment-variable support, provider differences, and retry behavior must be verified
against the shipped CLI and SDK before this design relies on a particular value.

### The Two Immediate Bugs

Claude times parsed messages, not component heartbeats. Healthy work can produce no such message for
longer than the threshold, causing an unjustified turn failure.

Hooks capture stdout and stderr through a pipe. A shell can launch a background service and exit
successfully while the service retains that pipe. `communicate()` still waits for output EOF; the
timeout then kills the service's process group. Script completion and output completion have been
mistaken for the same condition.

### Existing Hook Policies

| Boot mode        | Setup                                                  | Start                                                |
| ---------------- | ------------------------------------------------------ | ---------------------------------------------------- |
| Fresh            | Run for every repository; failures warn and continue   | Primary failure aborts boot; secondary failures warn |
| Image build      | Run for every repository; any failure aborts the build | Not run                                              |
| Repository image | Not run                                                | Primary failure aborts boot; secondary failures warn |
| Snapshot restore | Not run                                                | Primary failure aborts boot; secondary failures warn |

The initial hook fix preserves this matrix for genuine timeouts and nonzero exits. In particular, it
does not make fresh setup newly fatal or make image-build setup optional.

## Proposed Behavior

### 1. Remove Claude's Output-Silence Failure

Remove the timeout around each parsed-message read. Keep whole-turn deadline enforcement and surface
SDK transport failures, premature stream termination, and CLI result errors accurately. Preserve
already-emitted text and available usage information on every terminal path.

`BRIDGE_SSE_INACTIVITY_TIMEOUT` no longer applies to Claude. Document that change; do not retain a
no-op Claude setting that appears to protect against hangs.

The rationale does not depend on the CLI catching every hang. Silence is insufficient evidence to
fail the turn, and the whole-turn budget exists specifically to bound work that remains unfinished.
A CLI stalled outside its own request watchdogs remains a recognized residual risk.

Do not change the CLI byte-stream threshold merely to match the old bridge number. First verify the
shipped implementation and intended supported providers. If an upstream timeout is pinned in the
environment, define and test it once as an upstream policy, independently of the bridge's
event-stream policy. This investigation does not block removing the invalid silence detector.

### 2. Retain Scoped OpenCode Responsiveness Detection

Keep the current threshold initially. Rename logs and errors to describe the bridge's failure to
consume OpenCode stream data within the limit, rather than a silent model or definitively dead
server. Until receive inactivity is isolated, downstream processing remains a possible cause.

The current reader can stop consuming chunks while forwarding events. Therefore, reducing the
threshold requires a backpressure test and evidence that it measures receive inactivity rather than
time blocked in unrelated work. If isolation is needed, keep it local to stream consumption; do not
introduce a general heartbeat framework or unbounded event queue.

A first-byte or provider-stream watchdog belongs where OpenCode owns the provider connection. Its
absence is not repaired by inventing model-progress semantics for server heartbeats.

### 3. Resolve One Effective Execution Deadline

The control plane owns the resolved whole-turn policy and persists its deadline when execution is
dispatched. Retries of dispatch and reconnects must not restart the same turn's budget. Runtime
preparation after dispatch, including session creation and attachment processing, consumes it.

Use these conceptual values; they are not a finalized wire schema:

```text
turn_deadline = dispatch_time + resolved_turn_allowance

effective_execution_deadline =
    min(turn_deadline, known_provider_expiry - cleanup_and_snapshot_reserve)
```

The runtime converts remaining time to a local monotonic deadline. Do not exchange monotonic
timestamps between processes. Account conservatively for clock uncertainty and transport time;
delivery must not extend a deadline already running in the control plane.

The initial turn allowance preserves the existing resolved allowance rather than silently increasing
permitted execution. Separating it into a first-class session setting is a follow-up; it is no
longer described as the provider's remaining lifetime.

Provider adapters must distinguish a known hard expiry, a conservative expiry bound, and no known
hard expiry. Do not derive a universal authoritative deadline from `createdAt + timeoutSeconds`.
Known provider caps apply before dispatch. Resume or renewal updates must be scoped to the current
sandbox instance and must never reset the turn's own deadline.

When provider expiry is unknown, enforce the turn deadline but explicitly make no provider-lifetime
reserve guarantee. When insufficient known lifetime remains, do not start another turn. Preserve the
workspace and renew or replace the runtime through supported lifecycle paths; if that cannot be done
safely, report the limitation rather than claiming a successful handoff.

The reserve is one shared interval for interruption, escalation, and snapshot attempts. Each cleanup
step consumes what remains; interrupt and disconnect do not each receive a fresh full allowance.
Reserving time permits a snapshot attempt, not a guarantee of snapshot success.

### 4. Make Cancellation A Runtime-Reuse Boundary

Use the existing stop coordinator and stop-confirmation fence as the starting point, rather than
adding an independent watchdog state machine. Extend the contract where current evidence is too
weak. User Stop, runtime deadline expiry, control-plane execution expiry, and abnormal stream
termination must converge on the same containment rules whenever execution cessation is uncertain.

The lifecycle is:

```text
running -> stopping -> stopped / reusable
                    -> termination required / not reusable
```

This is separate from whether the user-facing message has already been recorded as failed.

1. Record the reason and prevent further prompt dispatch to that runtime.
2. Request graceful cancellation of the active turn. Do not treat cancellation of its event reader
   as cancellation of its tools or provider operation.
3. Await harness-specific evidence that active turn execution has ceased. An HTTP success status or
   an SDK interrupt-request acknowledgment alone is insufficient unless its contract establishes
   completion. Account for turn-owned tasks, not just the parent request.
4. If that fails, terminate owned execution through the harness or supervisor within the remaining
   allowance. Do not kill unrelated services after a successfully confirmed graceful stop.
5. If containment cannot be confirmed, quarantine the runtime and request provider termination where
   supported. Failure or lack of provider stop support must not release the dispatch fence.
6. Release the runtime only after confirmed cessation, or dispatch to a safely prepared replacement
   that cannot overlap the old execution against the same mutable workspace.

Process death does not necessarily cancel remote side effects already submitted to external systems.
Report uncertainty where the harness or tool cannot establish it; this design does not promise
rollback of external operations or exact final provider billing.

Stopping must not block the bridge's command receiver from handling shutdown or health traffic.
Correlate stop evidence with the message and sandbox instance. Duplicate Stop requests are
idempotent; late results cannot release a newer turn's fence or reverse a recorded timeout.

An event-stream timeout, transport loss, or premature EOF can end observation while execution
continues. A terminal path without evidence of execution cessation retains the reuse fence and
enters containment. A harness-confirmed completed error result does not automatically require
termination merely because the work failed.

The current `abort() -> bool` contract means best-effort request, not confirmation. Likewise, an
`execution_complete` emitted after reader cancellation is not reliable stop evidence. Tighten or
extend these semantics explicitly and gate new guarantees on runtime support.

Outstanding agent/tool execution is distinct from an intentionally backgrounded service whose
launcher already completed. Normal completion and confirmed graceful cancellation need not stop such
services, including those launched earlier in the cancelled turn. Process ancestry alone does not
establish unfinished tool execution. Escalation may disrupt those services when active execution
cannot otherwise be contained; report that consequence rather than promising preservation.

### 5. Align Watchdogs With Their Owners

The session alarm uses the same resolved effective deadline as the runtime and initiates the stop
coordinator on expiry. It must not merely clear the processing row while work continues.

The automation scheduler's recovery sweep is not a separate shorter turn budget. For running
sessions, reconcile with authoritative session execution state and its deadline. A startup timeout
remains separate. If an independent automation-wide budget is introduced later, name it and cancel
the associated execution; do not disguise it as session execution timeout bookkeeping.

If session state cannot be reached, preserve an explicit uncertain/recovery condition instead of
assuming that work stopped. Automation overlap admission must account for unresolved execution, not
merely whether the previous run has a terminal reporting status.

Retain idle-session heartbeat renewal during processing. It governs retention, not progress or
turn-budget extension. Also retain protection while cancellation is unresolved so idle snapshot
paths do not mistake uncertain execution for a quiescent runtime.

### 6. Fix Hook Observation Without Changing Readiness Policy

Run each hook with stdout and stderr directed to a regular file and await the shell process's exit.
Changing `communicate()` to `wait()` while retaining the pipes is not the proposed fix.

The script contract is:

> `setup.sh` must finish required provisioning before exiting successfully. `start.sh` must finish
> required initialization and return; launch long-running services in the background. A successful
> launcher exit does not independently certify service health.

On successful shell exit, preserve its background children. On nonzero exit or genuine timeout,
apply the existing boot-mode and repository-position policy for failure versus warning. Before
continuing, perform bounded cleanup of the failed hook's owned descendant tree, including after a
secondary start failure. On Linux this requires per-hook descendant ownership across `setsid` and
double-fork; other platforms retain process-group cleanup. Cleanup after a nonzero exit is an
intentional strengthening of current behavior; the fatal-versus-warning matrix is unchanged.
Cancellation, outer build deadlines, and supervisor shutdown remain cleanup events, not permission
to abandon provisioning processes.

Implement this behavior in the hook runner. Do not weaken the shared owned-subprocess helper used by
Git clone/fetch and other bounded operations.

Image-build success requires every setup shell to have exited successfully. Repository authors must
not background required provisioning and report success early. A timed-out installer must not
continue mutating files while the supervisor reports build completion or an image is captured.

Fresh setup remains best-effort as today, but the failed hook is cleaned up before subsequent phases
continue. This preserves existing degraded-boot behavior without adding uncontrolled overlap between
setup, start, and agent commands.

The initial-connect watchdog remains an outer constraint: clone, hooks, tunnel waits, and harness
startup happen before bridge connection. Multi-repository hook waits can exceed it. The pipe fix
does not solve genuine long boot or queued-prompt recovery; validate that interaction and report
which outer deadline fired rather than promising that every configured hook wait will elapse.

### 7. Treat Hook Logs As Managed Diagnostics

The runtime log contract is a per-boot, per-repository directory outside Git checkouts:
`/tmp/openinspect-hook-logs-<uid>/<boot-id>/<encoded-owner>/<repo-name>/`, containing `setup.log`
and `start.log` when those hooks run. Owners are encoded as one path segment, so repositories with
the same name do not collide and nested owner namespaces are not naively split into directories.

Expose the actual log path in diagnostics and agent-visible boot context. Files are private to the
sandbox user, opened as regular files without following pre-existing symlinks. A logging setup
failure must not fall back silently to the inherited-pipe behavior.

Build logs are temporary, restricted diagnostics, not image artifacts. Do not include their raw
contents in user-facing build callbacks or log tails. Remove them before successful image capture,
and clean them on failed or cancelled builds. Preserve the existing build-output confidentiality
policy; arbitrary shell output cannot be reliably scrubbed by a few string replacements.

Runtime logs may contain secrets too. Exclude managed raw hook logs from snapshot artifacts through
explicit snapshot preparation or verified provider support. Do not assume that `/tmp` or an
untracked file is automatically excluded from filesystem snapshots. If that exclusion is not
implemented, persistent file logging is not ready to ship on that capture path.

Bound retained output and remove obsolete boot logs. Any truncation or rotation must handle the file
descriptor inherited by a live service; renaming a path alone does not bound that writer. Log tails
are best-effort diagnostics, not a lossless service logging API. Long-running services that need
durable logs should manage their own output destinations.

### 8. Report Quiet Turns Without Inventing Progress

After five minutes without a meaningful timeline event during an active turn, display:

> No new output for 5 minutes; the turn remains active.

This is informational, not a failure or proof of forward progress. Scope it to the active message,
clear it when output resumes or the turn ends, and do not accumulate repeated warning rows. Bridge
heartbeats and the notice itself are not meaningful timeline activity.

Prefer deriving the initial notice from existing processing and timeline state in the web client.
Suppress reassurance when the connection state is stale or unknown; on reconnect derive it from
authoritative state rather than assuming silence continued during a client disconnect.

The existing persisted warning channel is not a transient status API and has a fixed scope enum. Do
not reuse it without accounting for replay, completion, and sidebar behavior. Cross-client or bot
quiet notices are deferred unless a concrete consumer requires them.

## Errors And Configuration

Errors name the actual owner and outcome, not a guessed root cause. Examples:

- "Turn duration limit reached; stopping execution."
- "Sandbox lifetime is nearly exhausted; stopping execution before cleanup."
- "The bridge did not consume OpenCode stream data within its responsiveness limit; receive or
  downstream processing may be stalled."
- "start.sh did not exit within START_TIMEOUT_SECONDS; its descendants were stopped."
- "Cancellation could not be confirmed; this runtime will not receive more work."

Only claim descendants were stopped or a snapshot was saved after confirmation. Include the resolved
duration, setting source, message/sandbox identity, and cancellation outcome in structured logs.
Preserve upstream error details subject to existing secret-handling policy.

Python durations use seconds; TypeScript durations use milliseconds. Encode units in names and
define each default once. Existing hook and OpenCode knobs remain reachable during migration. Do not
silently reinterpret their values as different timers. A future first-class turn setting must
document precedence over legacy derived values and be resolved in one place.

## Verification

Mocks are useful for translation and policy tests but insufficient for process-lifecycle claims. The
following are release criteria for the corresponding implementation phase.

### Required Regression: Quiet OpenCode Tool

A reported production case is an OpenCode turn executing `sleep 600`: the Bash process is healthy
but emits no output for ten minutes. This is a required named regression, not a Claude-only test.
Removing Claude's parsed-message timer does not fix the OpenCode path.

Run the command through the actual OpenCode Bash tool, with its tool timeout explicitly greater than
the command duration and enough remaining turn and provider lifetime. Keep the normal bridge and
control-plane inactivity thresholds; increasing them to exceed the sleep is not a passing fix.

- OpenCode stream traffic must continue to be consumed while the tool is quiet, keeping the bridge
  responsiveness deadline from firing.
- Independent bridge heartbeats must keep the processing session from being reaped at the
  control-plane inactivity threshold, even without forwarded timeline events.
- The tool must exit successfully and the same turn must produce a follow-up response, without a
  failure, automatic retry, sandbox replacement, or lost partial output.
- Repeat with a quiet duration beyond the control-plane inactivity threshold, avoiding dependence on
  whether a ten-minute command wins a race against a ten-minute alarm.
- Separately test lost heartbeats and slow downstream event forwarding. A quiet tool must not be
  mistaken for those conditions, and failures must identify the actual observation that expired.

Capture runtime generation, effective limits, received heartbeat timestamps, and the firing watchdog
in production reproduction. The current source has heartbeat protections on both hops; that alone
does not prove the affected deployed runtime received them or that backpressure did not prevent
their consumption. Until the real-path regression passes, this case is a design requirement, not a
verified production fix. An explicitly exhausted tool, turn, or provider budget remains a legitimate
reason to stop the command.

### Coverage Matrix

| Area                  | Required evidence                                                                                                                                              |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Quiet Claude turn     | A stream remains quiet beyond the former threshold and later completes successfully                                                                            |
| Claude failure        | EOF, transport errors, and error results preserve emitted output and report the actual failure                                                                 |
| Cancellation          | Real subprocess/tool fixtures cover successful interrupt, rejected interrupt, hung disconnect, and descendants surviving parent exit                           |
| Reuse fence           | No prompt dispatch while cancellation is unresolved; stale completion cannot release another message's fence                                                   |
| Cleanup budget        | Interrupt, termination, and snapshot attempts share one remaining allowance, including slow event delivery                                                     |
| Provider lifetime     | Late sandbox turns, provider caps, unknown expiry, resume/renewal, delivery delay, and exhausted reserve                                                       |
| Watchdogs             | Runtime and session expiry converge on one cancellation; scheduler does not falsely fail a valid longer turn or admit overlapping work                         |
| OpenCode health       | Regular stream traffic tolerates quiet tools; missing traffic fails accurately; downstream backpressure is distinguished before shortening the threshold       |
| Hook pipe inheritance | A real shell launches a child inheriting stdout and exits zero; boot proceeds promptly and the child remains alive                                             |
| Hook failure          | Nonzero shell exit is observed even with inherited output; surviving children after nonzero exit and genuinely hanging hooks are cleaned up with bounded waits |
| Boot policies         | Fresh/build/image/restore, primary/secondary, nonzero/timeout, outer cancellation, and multi-repository connect-watchdog interaction                           |
| Image completeness    | A timed-out setup produces no build-success callback or reusable image; delayed writes cannot race publication                                                 |
| Log safety            | Synthetic secrets absent from captured artifacts; bounded output with inherited descriptors; restrictive permissions and unsafe paths rejected                 |
| Quiet notice          | Appears only for the active connected turn, resets on meaningful output, and disappears on completion and Stop                                                 |
| Rollout               | Old image and snapshot behavior is explicit; legacy completion events are never mistaken for new stop guarantees                                               |

## Rollout

Deploy shared schema and control-plane consumers before runtimes that require new deadline or stop
semantics. Deployment of compatible consumers is not activation of stricter behavior for legacy
runtimes. Build `@open-inspect/shared` before dependent packages when those contracts change.

Use independently reviewable stages:

1. **Claude silence fix:** remove the per-read timer, preserve upstream failures, update tests and
   operator documentation. State the remaining best-effort cancellation and lifetime limitations.
2. **Hook observation fix:** regular-file output, log safety, shell-exit waiting, real-process
   tests, and unchanged fatal-versus-warning decisions. Log cleanup is part of this stage, not a
   later promise.
3. **Cancellation correctness:** strengthen harness evidence, bridge completion ordering, and the
   existing stop fence; route session execution expiry and uncertain stream failures through it.
   Gate activation on runtime support and the legacy-session policy below.
4. **Deadline ownership:** persist and deliver the effective deadline, add provider-expiry
   knowledge, share cleanup time, and reconcile automation recovery against authoritative execution
   state.
5. **Observability:** scoped OpenCode naming, neutral quiet-turn status, and precise failure text.
   Reducing the OpenCode threshold requires separate measured evidence.

Runtime changes require coordinated manifest version/generation and image cache-buster updates. Use
the repository's public-first deployment workflow and explicitly verify downstream manifest merges
where production sync requires them.

`minimumRebuildGeneration` requests replacement images; it does not prohibit booting compatible
older images. Snapshot restore uses the compatibility floor, not the rebuild floor, and can retain
an old runtime after image rebuilds finish.

The default rollout does not invalidate all snapshots. Record runtime generation in validation and
incident diagnostics, permit existing snapshots to retain old behavior temporarily, and do not
advertise universal adoption. Stronger protocol guarantees apply only to supporting runtimes.

Legacy sessions retain their documented existing best-effort Stop behavior until migrated; do not
activate stricter termination solely because an older runtime cannot supply new stop evidence. This
is a temporary, explicit exception to the target containment guarantee, not evidence that an old
completion event establishes the new guarantee. Existing legacy recovery behavior is not made
stronger by this rollout.

Migrating an affected snapshot-backed session requires a workspace-preserving refresh path or
explicit user-approved replacement. For upgraded runtimes, disclose that termination escalation can
lose changes since the last successful snapshot; attempt preservation only when safe and time
permits. Raising a compatibility floor can also lose uncommitted filesystem state and must be a
separate decision. The runtime-support gate and this legacy policy are prerequisites for stage 3.

## Alternatives And Deferred Decisions

### Uniform Harness Heartbeats

Not selected. They may improve transport diagnosis but do not establish progress or bound an
otherwise responsive turn. Hook and tool-progress events can be added for UX independently, using
supported SDK contracts rather than undocumented CLI frames.

### Continue Every Hook After Timeout

Not selected. It conflates an unmet dependency with readiness, can publish unfinished setup, and
allows late failures and mutations to escape existing boot ordering. Fixing output observation does
not require this policy change.

### Agent Availability Before Application Readiness

Potential future work. The agent could help repair failed setup if agent availability, repository
preparation, and application readiness were separate states. That requires explicit degraded-state
representation and rules for which operations are safe before preparation finishes. It is not
implemented by returning success from an unfinished hook and is not required for either immediate
fix.

### Open Implementation Decisions

- Which supported CLI timeout controls are verified and worth pinning independently of bridge
  policy.
- Exact provider-neutral expiry and stop-evidence fields, including legacy-runtime capability
  gating.
- Concrete bounded-log retention limits and a verified exclusion mechanism for each snapshot path.
- A safe workspace-preserving runtime refresh for sessions that repeatedly restore old snapshots.
- Whether a later product change makes primary runtime startup optional; setup in image builds
  remains required.

These decisions gate the stages that depend on them. No one-day estimate is attached to the full
design: deleting a false detector and correcting pipe handling are smaller changes than enforcing
cross-provider termination and lifetime guarantees.

## Source Map

- [Bridge budgets, execution, and Stop](../../packages/sandbox-runtime/src/sandbox_runtime/bridge.py)
- [Harness lifecycle contract](../../packages/sandbox-runtime/src/sandbox_runtime/harness/base.py)
- [Claude reads and interruption](../../packages/sandbox-runtime/src/sandbox_runtime/harness/claude.py)
- [OpenCode SSE client](../../packages/sandbox-runtime/src/sandbox_runtime/harness/opencode_client.py)
- [Repository hook execution](../../packages/sandbox-runtime/src/sandbox_runtime/repository_hooks.py)
- [Boot-mode failure policies](../../packages/sandbox-runtime/src/sandbox_runtime/repository_boot.py)
- [Owned-process cleanup](../../packages/sandbox-runtime/src/sandbox_runtime/process_output.py)
- [Supervisor and build completion](../../packages/sandbox-runtime/src/sandbox_runtime/supervisor.py)
- [Stop coordinator](../../packages/control-plane/src/session/execution-stop-coordinator.ts)
- [Session alarm](../../packages/control-plane/src/session/alarm/handler.ts)
- [Message queue and failure settlement](../../packages/control-plane/src/session/message-queue.ts)
- [Automation scheduler](../../packages/control-plane/src/scheduler/scheduler.ts)
- [Provider lifecycle contract](../../packages/control-plane/src/sandbox/provider.ts)
- [Connection and snapshot policies](../../packages/control-plane/src/sandbox/lifecycle/decisions.ts)
- [Image rebuild policy](../../packages/control-plane/src/image-builds/rebuild-policy.ts)
- [Runtime manifest](../../packages/sandbox-runtime/src/sandbox_runtime/runtime_manifest.json)
- [Image and secret retention](../SECRETS.md#secrets-and-prebuilt-images)
