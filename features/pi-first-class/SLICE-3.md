# Slice 3 foundation: external-action approval gateway

## Outcome

This change adds the disabled, provider-neutral foundation for Pi external effects. It does **not**
enable a production provider.

- SessionDO migration 60 owns immutable action documents, exact-call bindings, transition history,
  dispatch leases, indeterminate outcomes, and reconciliation.
- D1 migration 0090 owns executor-scoped automation grants. New binaries use a required atomic
  statement bundle that preserves audit ordering, revokes mismatched active grants, and lets user
  merge repoint historical references without altering prior revocations. Migration 0090 temporarily
  retains the equivalent trigger as a rollback bridge for pre-bundle binaries.
- Pi installs a mandatory effect-catalog policy. Unknown tools fail closed. Local mutation and
  sandbox execution require their own authorization gateways. External mutations prepare an action
  in SessionDO and execute only through a credential-free gateway tool.
- A blocked Pi tool call is terminal. Human approval is consumed only by a new call whose exact
  provider/action/target/arguments fingerprint is rebound to the approved action by SessionDO. The
  continuation is consumed once; a later identical intention creates a new action and approval.
- Provider/action definitions own request and public-result schemas. Provider credentials are closed
  over by the SessionDO executor and never appear in Pi arguments, action documents, or public
  results.

## Dormant product surface

The canonical `PI_EXTERNAL_ACTIONS_MODE` capability defaults to `off` and is durably latched for new
Pi sessions. The provider definition registry is empty. There is no automation-grant management API
or UI, and no session approval UI. The human status/decision HTTP foundation therefore cannot create
or execute a real action in production. It exists for a later provider slice, after that provider
passes the generic dispatch, ambiguity, restart, schema, and credential-leak tests.

## Recovery contract

An executor reports one of: succeeded with a schema-validated public result, accepted with a
provider reference, definitely rejected, pending, not admitted, or unknown. A thrown dispatch is
indeterminate and is never dispatched again unless provider status proves it was not admitted.
SessionDO alarms reconcile due leases and accepted/indeterminate actions, including after Durable
Object reconstruction. Human decision audits use a SessionDO outbox and the same earliest-deadline
alarm coordinator, retrying their D1 projection without owning a second alarm.

Runtime rehydration derives the next wake directly from the action ledger and audit outbox, so a
crash between committing either row and scheduling the shared alarm does not strand work. Every
unsuccessful reconciliation attempt, including a missing provider definition or thrown status
request, durably advances a bounded exponential backoff before the alarm is rearmed.
