# Upgrading without silently replacing session state

Session snapshots contain both the working filesystem and harness state. A fresh checkout is not a
continuation of that state, even when the session event stream still displays the previous
conversation.

## Runtime floors are different controls

| Manifest field                  | Effect                                                                                                                                              |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `minimumCompatibleGeneration`   | Blocks execution of older snapshots and selection of older repo images. Existing snapshot references are retained, not replaced by a fresh sandbox. |
| `minimumRebuildGeneration`      | Requests image rebuilds; does not invalidate session snapshots. Use for routine runtime updates.                                                    |
| `minimumPreservationGeneration` | Defines confirmed-shutdown protocol support and also restricts selection of repo images for new launches.                                           |
| `harnessMinimumGeneration`      | Adds a repo-image floor for a particular harness.                                                                                                   |

Raising an image-selection floor before compliant images are ready causes base-image fallback. The
control plane's compiled runtime version is not proof of which runtime a separately deployed data
plane actually serves. Deploy and verify runtime support, then rebuild images, before activating
code that requires that support.

## One-time transition to shutdown ownership

An execution started before the shutdown coordinator was introduced has no shutdown record. Ordinary
subsequent deployments do not erase existing durable records. This change does not adopt running
executions, invent their remaining lifetime, or add a background migration sweep.

For each installation crossing that boundary, including installations skipping intermediate
releases:

1. Pause new session creation and prompt intake at the deployment's ingress, including bots and
   scheduled automation. Let active prompts finish, or explicitly interrupt them; do not
   automatically replay partially executed work.
2. Inventory authoritative per-session sandbox state and running provider objects. D1 session status
   alone is not enough: snapshots and shutdown records live with the session, and a terminal session
   can still have retained state.
3. Capture/export the legacy executions while they still exist. Record each source handle, snapshot
   identifier, runtime version, and capture result. Preserve tracked, untracked, ignored, and
   secondary-repository files as well as harness state; pushing a Git branch alone is not a complete
   backup.
4. Verify the recovery artifacts and source retirement before proceeding. Missing or uncertain
   capture/stop results are a **stop condition**, not evidence that the provider did nothing. Keep
   unresolved sources and previous artifacts available.
5. Deploy the runtime, rebuild compliant images, and activate the control plane and compatible
   recovery UI. Verify a representative restore before reopening intake.

These are operator rollout requirements, not an automated deployment gate. Do not assume that
installing this change retroactively protects a legacy execution from a provider-enforced expiry
before it is captured.

## Permanent behavior

- **Incompatible or unversioned snapshots:** startup is held with a durable explanation. The
  original snapshot reference remains in the sandbox record. No verified receipt is fabricated from
  a legacy reference with missing provenance.
- **Unavailable restore support or failed snapshot restoration:** no clean replacement is
  substituted. An ambiguously invoked restore remains held across reconstruction.
- **Fatal/unresponsive serving executions:** the shutdown owner fences admission, attempts a bounded
  crash-recovery capture (or a preserve-stop for a provider without snapshots that supports
  persistent resume), commits the receipt and snapshot projection together, then confirms
  retirement. A failed boot does not acquire a new recovery snapshot of its broken initial
  filesystem.
- **Uncertain results:** capture or retirement uncertainty keeps the session held; alarms and new
  prompts cannot turn it into permission to destroy or start fresh.
- **Interrupted work:** the active prompt is failed once, later prompts stay pending, and
  continuation requires the existing explicit recovery action. Recovery does not roll back external
  effects or replay the interrupted prompt.
- **Actual clean replacement without a snapshot:** a warning is persisted in the session event
  stream. Warning delivery/storage failure is logged but cannot abort replacement after the old
  generation has been relinquished.

Emergency capture cannot confirm that an unreachable runtime quiesced its tools. Treat its artifact
as crash recovery, not an application-consistent or exactly-once checkpoint. Normal graceful
shutdown still uses the runtime preparation handshake. Normal inactivity and heartbeat handling are
not converted into a new migration mode.

## Recovering a blocked old snapshot

Keep the session and its artifact identifiers intact. An operator can use the retained provider
artifact for isolated inspection/export and transfer the recovered workspace and harness data to a
compatible environment. Do not attach an obsolete runtime to the current control plane merely to
bypass its compatibility floor. Validate the provider's retention policy: keeping a database
reference does not extend an artifact's provider-side lifetime.

Starting a separate session is an explicit fresh start and leaves the original record available for
investigation. Do not clear snapshot fields or manufacture shutdown receipts to make a blocked
session appear recovered.

## Verification before deployment

Focused regressions exercise the real manager, coordinator, message completion service, and SQLite
repositories inside Workerd. Provider operations and transport are substituted; queue callbacks
record admission decisions and status reconciliation is a no-op. These are lifecycle/persistence
tests, not an end-to-end test of the production queue and status wiring. They cover legacy state,
compatibility rejection, near-drain capture, interrupted prompts, reconstruction, late results,
ambiguous provider responses, transactional rollback, persistent resume, and notification failure.

Run a provider-backed canary as well: create tracked/untracked/ignored and secondary- repository
sentinels, establish harness conversation state, interrupt a serving execution, verify the recovery
pause, explicitly resume, and check the files and conversation. Verify the old source is retired and
that the interrupted prompt is not replayed. Repeat the legacy-to-current upgrade with intake
paused. Unit and Workerd tests cannot establish provider retention, expiry, or snapshot consistency
behavior.
