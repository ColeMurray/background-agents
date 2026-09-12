# Atomic Model Preference Updates

## Problem

Model preferences are currently saved as unconditional full-list `PUT` requests. The web client uses
an SWR cache entry as a shared write lock to prevent overlapping requests in one browser cache, but
this drops overlapping actions, treats local coordination state as a fetchable resource, and cannot
prevent lost updates across tabs or administrators.

## Goals

- Express settings changes as enable/disable operations rather than stale full-list replacements.
- Apply concurrent changes atomically on the server without losing independent updates.
- Keep model toggles optimistic and preserve pending work across normal app navigation.
- Queue every frontend action rather than dropping actions while a request is pending.
- Keep the server authoritative for model validation and the at-least-one-enabled invariant.
- Remove the SWR pseudo-key and all cache-backed locking behavior.

## API

Add `PATCH /model-preferences` with this request shape:

```json
{
  "changes": [
    { "modelId": "anthropic/claude-haiku-4-5", "enabled": true },
    { "modelId": "openai/gpt-5.4", "enabled": false }
  ]
}
```

The request must contain at least one change. Model IDs must be canonical and unique within the
request. GET and PATCH responses contain the resulting `enabledModels` list and its monotonic
`revision`. Category actions are represented by one request containing all changes in that category.

The web BFF exposes PATCH through the existing settings proxy. Legacy PUT writes are rejected
because their full-list body has no revision or operation intent and can overwrite a concurrent
PATCH.

## Atomic Storage

Add a non-null integer `revision` column to `model_preferences`, defaulting existing rows to 1.
PATCH processing validates the changes, reads the current value and revision, applies the changes,
and conditionally writes with `WHERE revision = ?` while incrementing the revision. An absent row is
inserted with conflict detection. A conflicting writer causes the operation to reread, reapply, and
retry up to one named retry limit. Exhausted contention returns HTTP 409.

The existing JSON storage remains appropriate for the small model catalog. A normalized membership
table would add schema and query complexity without improving the operation semantics.

Every accepted operation, including a logical no-op, performs the conditional write so it has a
defined serialization point. The server rejects a resulting empty set.

## Frontend Ownership

Add a client `ModelPreferencesProvider` under the authenticated app layout. It owns the single SWR
read, optimistic operations, a FIFO request queue, pending count, and reconciliation. Existing read
consumers continue using `useEnabledModels` through context.

Each action immediately enters the optimistic overlay and the queue. Requests run sequentially. A
PATCH response updates the confirmed SWR value only when its revision is at least as new as the
cached snapshot, after which remaining valid queued operations are reapplied. Controls remain
interactive while saving, and `saving` reflects whether the queue has pending work.

On a failed or ambiguous request, the provider removes that operation, revalidates from the server,
and reapplies remaining operations without exposing or dispatching a change that would disable every
model. Rejected action promises let the settings panel show an error. The provider remains mounted
across normal settings navigation; server-side operation semantics protect correctness across hard
reloads and other clients.

## Shared Logic

Define the operation protocol and a pure `applyModelPreferenceChanges` helper in the shared package.
The browser and control plane use the same ordering and set-membership behavior. Existing enabled
models retain their order, disabled models are removed, and newly enabled models append in request
order.

## Verification

- Shared unit tests cover validation-independent operation application and ordering.
- Control-plane unit and integration tests cover PATCH validation, missing and malformed storage,
  revision increments, the final-model invariant, CAS retries, and concurrent independent updates.
- Web unit tests cover immediate optimism, queued rapid actions, authoritative responses, failures,
  reconciliation, category batches, navigation persistence, and removal of the SWR lock key.
- Build the shared package before dependent typechecks and tests.
- Run relevant shared, control-plane integration, and web suites plus repository lint/typecheck.

## Separate Concern

This change fixes preference persistence concurrency. Enforcement of the enabled list across every
session, automation, GitHub, and Linear execution path is a separate policy issue and is not part of
this redesign.
