# Turn timeouts, cancellation, and boot readiness

Implementation and rollout notes for [the timeout redesign](plans/timeout-redesign.md). The policies
below are separate clocks, not interchangeable signs of model progress.

## Turn policy

- Claude no longer fails a turn because parsed SDK messages are quiet.
  `BRIDGE_SSE_INACTIVITY_TIMEOUT` applies only to OpenCode stream consumption.
- OpenCode retains its existing responsiveness threshold. Its error identifies missing consumed
  stream data or stalled downstream forwarding, not a dead model. A bounded receive buffer keeps
  ordinary event forwarding separate from receive inactivity; sustained backpressure fails
  explicitly.
- The control plane persists an absolute execution deadline at first dispatch. Session preparation,
  attachments, transport delay, retries, and reconnects consume the same allowance. The runtime
  converts remaining wall-clock time to a monotonic deadline, subtracting a one-second clock margin.
  This assumes ordinarily synchronized clocks; it is not an arbitrary-clock-skew guarantee.
- Session sandbox-duration settings keep precedence. The historical runtime allowance is that
  duration minus `min(900 seconds, 25% of duration)`. Without a session override,
  `EXECUTION_TIMEOUT_MS` can cap that allowance without receiving another reserve deduction. The
  default remains a 6,300-second turn allowance and at most 900 seconds of cleanup.
- A known provider expiry can shorten the execution deadline to preserve cleanup time. Provider
  renewal cannot extend an already-dispatched turn. With unknown expiry there is **no
  provider-lifetime reserve guarantee**. Insufficient remaining lifetime rejects dispatch with a
  runtime-refresh explanation; it does not silently discard the workspace or promise renewal
  succeeded.

The persisted cleanup deadline is one allowance for interruption, containment, terminal delivery,
and safe snapshot attempts. A failed capture is not a saved snapshot, and exhausted lifetime cannot
guarantee preservation.

| Provider     | Lifetime evidence                                                              | Runtime raw hook output                              |
| ------------ | ------------------------------------------------------------------------------ | ---------------------------------------------------- |
| Modal        | Conservative bound from the provider-side launch request                       | Private files, removed before filesystem capture     |
| Vercel       | Conservative bound respecting requested/acknowledged lifetime and provider cap | Private files, removed before capture                |
| E2B          | Provider `endAt` when available; conservative acknowledged-timeout fallback    | Discarded; memory-preserving pause remains available |
| OpenComputer | Conservative bound after acknowledged lifetime renewal                         | Discarded; hibernation remains available             |
| Daytona      | Unknown hard expiry                                                            | Private files; no new snapshot-exclusion claim       |

Expiry and runtime capabilities are scoped to the current sandbox instance. The queue waits for the
provider launch response before using a fast-arriving bridge connection to dispatch work.

## Cancellation and runtime reuse

Supporting runtimes advertise `execution-deadline-v1` and `stop-confirmation-v1`. Prompt/Stop
commands and terminal evidence are correlated with message and sandbox identity. The session's
existing stop coordinator owns the durable dispatch fence:

```text
running -> stopping -> confirmed stopped -> reusable
                    -> uncertain -> quarantined / provider termination
```

Message failure and execution cessation are distinct. User Stop, turn expiry, session-watchdog
expiry, and lost observation converge on cancellation. Neither interrupt acknowledgment, HTTP abort
success, nor cancelling an event reader proves that tools or descendants stopped. The bundled Claude
SDK's disconnect can reap its CLI while a detached descendant survives; that path cannot release the
fence. An unconfirmed upgraded runtime receives no more work, even if its message is already
reported failed. Confirmed normal completion does not kill intentionally backgrounded services.

Provider escalation can interrupt services and lose changes since the last successful snapshot. It
cannot roll back remote operations already submitted by a tool. Failed or unsupported containment
does not release an upgraded runtime's dispatch fence. Late results cannot reverse a recorded
timeout or release another message's fence.

The automation recovery sweep asks the session for authoritative execution state; it is no longer a
separate shorter turn budget. Startup still has its own limit. Unreachable sessions and unresolved
enqueue/cancellation remain explicit recovery conditions and prevent overlapping automation
admission, including when a run's reporting status is terminal.

## Hook completion and diagnostics

`setup.sh` must finish required provisioning before exiting successfully. `start.sh` must finish
initialization and return, launching long-running services in the background. A successful launcher
exit is not an independent service-health check.

The hook runner observes shell exit separately from inherited output descriptors. Successful shell
exit preserves background children. On Linux, a per-hook subreaper owns descendants that detach,
call `setsid`, or double-fork; nonzero exit, genuine timeout, cancellation, and supervisor shutdown
kill and reap that complete descendant tree before dependent boot work proceeds. Other platforms
retain process-group cleanup. If cleanup cannot be confirmed within its bounded wait, boot cannot
safely continue. The shared Git/subprocess helper is unchanged.

| Boot mode                            | Setup failure                                            | Start failure                                  |
| ------------------------------------ | -------------------------------------------------------- | ---------------------------------------------- |
| Fresh                                | Warn and continue after cleanup                          | Primary fatal; secondary warning after cleanup |
| Image build                          | Any failure fatal; no success callback/image publication | Not run                                        |
| Repository image or snapshot restore | Not run                                                  | Primary fatal; secondary warning after cleanup |

`SETUP_TIMEOUT_SECONDS` and `START_TIMEOUT_SECONDS` remain hook waits. The initial-connect watchdog
is still an outer constraint covering clone, hooks, tunnel waits, and harness startup; it can expire
before all configured hook waits in a multi-repository boot. The hook fix does not extend it.

For file logging, diagnostics live outside repositories at
`/tmp/openinspect-hook-logs-<uid>/<boot-id>/<encoded-owner>/<repo-name>/{setup,start}.log`. Private,
atomically recorded boot ownership ensures cleanup removes only the exact directory created by the
runtime; repository-owned `.openinspect` paths and unrecorded siblings are untouched. Paths use
no-follow handling and agent-visible path-only context, and raw contents are not placed in build
callbacks. The janitor truncates the same inode at a 1 MiB target every 250 ms, including
descriptors inherited by successful services. This is best-effort retention, not a hard disk quota
against an arbitrary write burst or a durable service-log API. Services needing durable logs must
choose their own destinations.

**Memory-capture exception:** E2B and OpenComputer session launches enforce `HOOK_LOG_MODE=discard`.
They use the same shell-completion and cleanup policy, but retain only structured hook outcome
metadata, not raw stdout/stderr files or a misleading log path. Deleting a filename cannot prove
exclusion from a live-memory/open-descriptor checkpoint. This deliberately preserves existing
workspace pause/resume behavior without claiming that exclusion. Image builds still use restricted
file logging and remove it before success publication. Other sessions default to file logging.

File-backed runtime logs are removed during correlated snapshot preparation; supporting runtimes
that cannot complete that preparation cannot produce a new snapshot. This does not scrub arbitrary
files a repository script creates. See
[secrets and prebuilt images](SECRETS.md#secrets-and-prebuilt-images).

## Quiet-turn status

The web client shows one transient status after five minutes without meaningful output:

> No new output for 5 minutes; the turn remains active.

It is message-scoped and disappears on output, completion, or Stop. Heartbeats are not timeline
progress. Stale/unknown connections suppress the notice; reconnect uses the authoritative replay. No
warning rows are persisted, and bot quiet notices are not part of this change.

## Rollout and validation

1. Deploy compatible shared/control-plane consumers and the automation recovery migration first.
   Build `@open-inspect/shared` before dependent packages. Deploy the Modal termination endpoint
   before relying on provider-confirmed Modal termination.
2. Build and verify runtime `v67-timeout-redesign` images. The manifest generation and rebuild floor
   are 67; the global compatibility floor stays 62 and the Claude image floor stays 64. Modal's
   cache buster derives from the runtime version; the shared image bundle also includes it.
3. Deploy runtime-producing services through the public-first workflow. Verify downstream production
   manifest merges explicitly; do not lower the new rebuild generation during conflict resolution.
4. Validate actual runtime version/capabilities for each canary. Existing compatible images can
   still boot, and snapshot restoration uses the compatibility floor, **not** the rebuild floor.
   Rebuilding images does not migrate an old snapshot's runtime. Legacy sessions retain their
   explicitly weaker Stop/recovery contract until refreshed; old completion events are not new
   cessation evidence.
5. Refresh affected snapshots through a workspace-preserving path or an explicitly approved
   replacement. This change does not raise the compatibility floor or invalidate all snapshots.

The opt-in real OpenCode regression is
`packages/sandbox-runtime/tests/integration/test_opencode_quiet_tool.py`. It runs the shipped
OpenCode Bash tool for 600 seconds and beyond the session idle threshold, with explicit larger tool
budgets and a deterministic local provider. It checks stream consumption, bridge heartbeat receipt,
partial/final output, successful follow-up, and no retry/replacement. The local WebSocket peer is
not a deployed SessionDO: passing it plus clock-driven DO tests does **not** establish production
adoption or replace a canary of the complete deployed path.

Capture runtime generation, deadline sources, received heartbeats, and the firing watchdog in a
production reproduction. Remote provider deployments, real provider lifetime expiration, and
workspace-preserving migration of existing snapshots must be verified in their deployment
environment.
