# ADR 0004: Sandbox Checkpoint and Shutdown Ownership

## Status

Accepted.

## Context

A sandbox execution may have a provider-enforced lifetime. Before its useful lifetime ends, the
control plane must stop admitting work, quiesce execution, save recoverable state, and confirm that
the source has stopped. A successful checkpoint is not permission to resume the retiring execution.
The control plane may restart during any step, and a lost provider response is not proof that the
remote operation failed or stopped.

The previous preservation interface distributed this guarantee across a lifecycle manager,
preservation coordinator, runtime handler, queue, and push service. Callers assembled admission
rules, transaction boundaries, checkpoint settlement, and recovery decisions themselves. A generic
checkpoint lease hid timers but left its caller responsible for deciding whether release was safe.

## Decision

### One authoritative lifecycle boundary

`SandboxLifecycleManager` owns the externally consumed readiness, work-admission, and recovery
policies. Its internal `SandboxShutdownCoordinator` owns the durable checkpoint-and-shutdown
protocol. Runtime handlers, queue processing, push, and recovery commands use the lifecycle boundary
instead of combining coordinator state with manager flags.

This is one subsystem with focused collaborators, not two peer lifecycle authorities or one giant
class. Queue acquisition and live push have intentionally different policies: queued work may need
to restore an execution, whereas a push requires a live command-ready execution.

Generation reservation is one synchronous operation: write the sandbox identity and shutdown
ownership in the same transaction, then announce only after commit. The consumer does not manage a
separate reservation/announcement sequence.

### Distinguish checkpoint, shutdown, and recovery

- An **ordinary checkpoint** captures recoverable state and may allow the current execution to
  continue, but only when its outcome permits exclusion to be safely released.
- **Graceful shutdown** closes admission for the retiring execution, requests bounded quiescence,
  captures recoverable state, and confirms source retirement. Only shutdown-related work may run
  after admission closes. Failure or uncertainty must not reopen admission.
- **Recovery** starts a separately authorized execution from saved state. It is not a transition of
  the retiring execution back to command readiness.

Ordinary and terminal capture share ownership of provider invocation, outcome classification,
recording, and operation-scoped settlement. The public operation reports domain outcomes rather than
exposing a generic promise runner and a caller-controlled `finish()`.

A provider timeout, transport exception, ambiguous unsuccessful response, or lost response is
unknown unless the provider contract establishes a stronger outcome. Aborting a local request or
expiring a timer does not establish remote cancellation. Stale results cannot publish a checkpoint
for a replacement generation or release another operation's exclusion.

### Keep scheduling bounds separate from retirement evidence

A conservative request-start-plus-timeout estimate can schedule shutdown early. It cannot prove that
execution has ended: actual creation may have happened later. Persist the evidence needed to
distinguish a scheduling estimate from authoritative expiry. Older records lacking that evidence
must not authorize skipping verified retirement.

Saved state and source retirement are separate facts. Successful shutdown requires both. Retirement
evidence for an old execution cannot prove that a later, ambiguously invoked restore created no new
execution.

### Continuation is a session policy, not checkpoint cleanup

If shutdown interrupts an active prompt, terminalize that prompt once using the existing failure
representation, report its interruption, and leave later prompts pending. This pause is durable:
reconnects, alarms, new prompts, and runtime readiness do not clear it. The user must explicitly
authorize resume before queued work may restore and continue. Never automatically replay the
interrupted prompt; restoring files cannot roll back external effects or establish that a partially
completed task is safe to repeat.

If shutdown occurs at a clean prompt boundary, queued work may automatically restore into a new
generation after checkpointing and retirement are confirmed. That generation must pass the usual
startup, lifetime, and runtime-readiness gates. The shutdown coordinator reports completion; the
lifecycle/session policy decides whether to wake queued work.

### Recovery availability and request acknowledgement

The lifecycle subsystem projects `availableRecoveryActions` using the same eligibility checks it
applies when executing a recovery command. Receipt existence is informational, not permission to
restore: the current generation, source provider, receipt provider, and retirement prerequisites
must agree. The UI renders these actions without reconstructing provider policy. Missing action
metadata means no recovery controls; lifecycle authorization is still checked for every command.

Recovery commands optionally carry `clientRequestId` for compatibility with existing clients. New
clients receive a sender-only `shutdown_recovery_accepted` acknowledgement or a correlated error.
Acceptance is not proof that restoration completed; the durable shutdown state remains
authoritative. While awaiting acknowledgement, the UI prevents duplicate submissions. A disconnect
or timeout means the result is unconfirmed, not that the operation failed or was cancelled, and
never triggers an automatic retry. Legacy requests without an ID receive no new acknowledgement
message.

### Compatibility and terminology

Use shutdown terminology for the internal lifecycle operation and checkpoint/recovery terminology
for the distinct concepts. Retain existing `preservation` wire message identifiers, serialized
fields, and SQLite storage names for compatibility with deployed runtimes and clients; a terminology
cleanup must not silently become a protocol or data migration. Source module, type, and schema
variable names are not wire contracts. Persisted recovery receipts remain internal and are
translated into domain decisions rather than returned as an overloaded artifact identifier.

Internal policies, repositories, collaborators, and their test files use `shutdown` naming,
including `shutdown-policy.ts` and `sandbox-shutdown-repository.ts`. The shared `sandbox-shutdown`
module exports `SandboxShutdownState` and `sandboxShutdownSchema` without changing their serialized
shape. Runtime `shutdown_preparation.py` exposes `ShutdownPreparationCoordinator`: it owns fencing
and preparation, not provider checkpoint capture or retirement. Internal lifecycle APIs, UI
callbacks, and user-facing wording use shutdown terminology too.

`MIN_SHUTDOWN_PROTOCOL_RUNTIME_GENERATION` names the existing protocol-support threshold; the
runtime manifest keys, version string, and generation values remain unchanged. Existing log-event
identifiers also remain stable until their dashboard and alert consumers are reviewed explicitly.

## Consequences

- Callers no longer reconstruct shutdown safety from multiple collaborators or cleanup callbacks.
- An interrupted prompt requires explicit resume; clean-boundary continuation remains automatic.
- Ambiguous checkpoint responses may now hold execution where the previous implementation resumed.
- Conservative or unproven expiry may require a provider retirement check that was previously
  skipped.
- The persisted protocol and existing runtime compatibility floors remain unchanged. Legacy
  execution does not acquire confirmed-shutdown guarantees merely through renaming.
- A provider hard deadline may still prevent checkpoint completion. Unknown outcomes stay visible
  and fenced; the system does not claim exactly-once external effects or guaranteed recovery.

## Validation and Rollout

Require regressions for lost capture responses, lifetime provenance, transaction rollback,
interrupted-prompt pauses across restart, explicit resume without prompt replay, clean-boundary
continuation, and readiness/late-result fencing. Validate the assembled lifecycle with real SQL and
Workerd as well as unit tests. Provider-backed canaries and compatible user recovery controls remain
rollout requirements; this decision does not authorize deployment.
