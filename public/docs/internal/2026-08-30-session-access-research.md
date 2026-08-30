# Research: Session Access and Contribution

**Date:** 2026-08-30 **Status:** Superseded current-state snapshot **Scope:** Session permission,
relationship, participant, listing, and WebSocket behavior before workspace-wide session
authorization was adopted.

This document is intentionally research-only. It does not include recommendations, implementation
plans, proposed code/API/schema changes, task breakdowns, estimates, or rollout steps.

The accepted replacement is
[Workspace-Wide Session Authorization](./2026-08-30-workspace-wide-session-authorization-design.md).

## Summary

The current system does not generally require a user to be a session creator or participant before
they can read or contribute to a session. Built-in Members receive `sessions.read.any` and
`sessions.collaborate.any`; Viewers receive `sessions.read.any`. These `any` permissions bypass the
`session_access` relationship table entirely. An unrelated Member can therefore list, read, prompt,
upload collaborative artifacts, and request a WebSocket token for any workspace session.

`session_access` remains active in narrower workflows. It gates Member lifecycle and sandbox access,
requires creator status for Member deletion and participant management, supports custom roles that
hold only `.own` permissions, filters own-scoped lists, and constrains every actor-backed bot call
because service actors are forced to `own` scope. WebSocket subscription also consults it when the
user's collaboration permission resolves to `.own`.

The system also has a separate Session Durable Object `participants` table. It stores session-local
identity, SCM metadata, WebSocket tokens, presence identity, and an `owner` or `member` role. It is
not the authority used by `requireSession`, but title, archive, and unarchive still require the
caller to exist in that table. D1 relationships and Durable Object participants can therefore
diverge and have different effects.

The resulting complexity represents several different concerns under similar terminology rather than
one uniform contribution boundary.

## Research Questions

1. Does session access currently restrict who can read or contribute to a session?
2. Which operations still depend on creator or participant relationships?
3. What does `requireSession` enforce for humans, services, and sandboxes?
4. How do D1 `session_access` and Durable Object participants differ?
5. Which current behaviors and documents are inconsistent or ambiguous?

## Current Behavior

### Built-in role behavior

The built-in role registry gives Members these session permissions:

- `sessions.read.any`
- `sessions.collaborate.any`
- `sessions.lifecycle.own`
- `sessions.participants.manage.own`
- `sessions.delete.own`
- `sessions.sandbox_access.own`

Viewers receive `sessions.read.any` and no contribution or lifecycle permission. Administrators and
Owners receive the `any` form of every session operation.

`resolveScopedPermission()` selects `any` before `own`. The router does not query a session
relationship after resolving `any`.

Consequences for a built-in Member:

| Operation                                                           | Existing relationship required? | Current basis                                                    |
| ------------------------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------- |
| List sessions                                                       | No                              | `sessions.read.any`                                              |
| Read session state, messages, artifacts, media, diffs, and children | No                              | `sessions.read.any`                                              |
| Submit an HTTP prompt                                               | No                              | `sessions.collaborate.any`                                       |
| Request a WebSocket token                                           | No                              | `sessions.collaborate.any`                                       |
| Upload attachments, media, or diffs                                 | No                              | `sessions.collaborate.any`                                       |
| Create a pull request or child session                              | No prior relationship           | `sessions.collaborate.any`, plus operation-specific requirements |
| Stop, rename, archive, unarchive, refresh, or retry                 | Yes                             | `sessions.lifecycle.own`                                         |
| Obtain sandbox credentials                                          | Yes                             | `sessions.sandbox_access.own`                                    |
| Delete a session                                                    | Creator only                    | `sessions.delete.own`                                            |
| Manage participants                                                 | Creator only                    | `sessions.participants.manage.own`                               |

An Administrator or Owner bypasses these relationship requirements through the corresponding `*.any`
permission at the router layer.

### Operation-to-relationship mapping

`session-authorization-policy.ts` maps each operation to both a permission stem and an own-scope
relationship:

| Operation              | Permission stem                | Relationship under `.own` |
| ---------------------- | ------------------------------ | ------------------------- |
| Read                   | `sessions.read`                | Creator or participant    |
| Collaborate            | `sessions.collaborate`         | Creator or participant    |
| Lifecycle              | `sessions.lifecycle`           | Creator or participant    |
| Participant management | `sessions.participants.manage` | Creator                   |
| Sandbox access         | `sessions.sandbox_access`      | Creator or participant    |
| Delete                 | `sessions.delete`              | Creator                   |

The term `own` therefore has two meanings in current policy. For four operations it means any access
relationship; for deletion and participant management it means creator.

### `requireSession`

`requireSession(operation, sessionIdParam)` creates an active-user route policy with one session
requirement. At request admission, the router:

1. Loads the effective authorization for the human user or represented service actor.
2. Rejects suspended users and missing role assignments.
3. Resolves the operation's `any` or `own` permission.
4. Applies the signed service's capability ceiling.
5. Forces signed service actors to `own` scope.
6. Queries `session_access` only when the resulting scope is `own`.

Relationship failures return `session_access_required` or `creator_required` with HTTP 403.
Unexpected authorization storage failures return `authorization_unavailable` with HTTP 503.

For sandbox-fallback routes, `requireSession` describes the user/service path. A verified sandbox
principal does not have a workspace user authorization and bypasses these RBAC requirements. Its
authority comes from the sandbox token being bound to the route's session ID.

### D1 `session_access`

Migration 0071 defines one canonical relationship per session and workspace user:

```sql
CREATE TABLE session_access (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  relation TEXT NOT NULL CHECK (relation IN ('creator', 'participant')),
  PRIMARY KEY (session_id, user_id)
);
```

The table contains no activity state, timestamps, invitation source, participant identifier, or
WebSocket state.

Creator rows are inserted with the D1 session index. Migration 0071 backfills canonical historical
creators. Participant rows are inserted after:

- successful public WebSocket-token issuance;
- successful public participant addition.

Participant activation uses `ON CONFLICT DO NOTHING`, so an existing creator row is never downgraded
to participant.

There is no production participant-removal route or D1 deactivation helper. Relationship deletion
currently occurs through session/user cascade, user merge, test setup, or direct database activity.

### Session Durable Object participants

The Session Durable Object has a separate `participants` table containing:

- a session-local participant ID;
- a provider/session-local `user_id`;
- an optional canonical D1 `canonical_user_id`;
- SCM identity and credentials;
- `owner` or `member` role;
- WebSocket token hash and issuance time;
- join time.

Session initialization creates an owner participant. WebSocket-token issuance creates or enriches a
member participant. API prompt enqueue also creates a missing participant.

The DO `owner` or `member` value is not read by `requireSession`. Canonical creator authority comes
from D1 `session_access.relation = 'creator'`. The DO role is returned in participant responses and
persists as session-local state.

Title, archive, and unarchive differ from other lifecycle routes: after router authorization, their
DO handlers also require the acting identity to exist in the local participants table. Stop, pull
request refresh, diff retry, and child cancellation do not share that second participant-existence
check.

### Contribution paths

HTTP prompt admission uses `requireSession("collaborate")`. For a built-in Member this resolves to
`collaborate.any`, so no relationship is required. The DO creates a participant when the prompt
author is not already present, but this prompt path does not create a D1 `session_access` row.

WebSocket-token issuance also uses `collaborate`. A successful token response creates both a DO
participant and a D1 participant relationship. This means the common browser join flow establishes
the relationship after open collaboration has already authorized the join.

Once a browser WebSocket subscribes successfully, prompt, cancel, stop, history, typing, and
presence messages use the authenticated client and its authorization lease. Individual WebSocket
commands do not independently resolve read, collaborate, or lifecycle permissions.

### WebSocket authorization

The initial WebSocket upgrade verifies only that the session exists. The socket remains
unauthenticated until it sends a subscription token.

Subscription verifies:

- the token hash maps to a DO participant;
- the participant has a canonical user ID;
- the canonical user is active and assigned;
- current `sessions.collaborate` permission;
- D1 access when collaboration scope is `.own`;
- the 24-hour token lifetime.

A successful subscription receives a five-minute authorization lease. During that lease, permission
and relationship changes are not continuously queried. Expiry closes the socket and a later
subscription evaluates current authorization again.

For the built-in Member's `collaborate.any`, subscription does not require the D1 relationship. For
custom roles with only `collaborate.own`, removing the relationship causes a later subscription to
fail.

### Lists and displayed capabilities

Session list and inbox SQL use `sessionAccessPredicate()` only when read scope is `own`. For scope
`any`, the predicate is `1 = 1`.

Because Member and Viewer use `read.any`, their ordinary lists are workspace-wide. The `Mine` filter
is separate: it filters `sessions.user_id`, which is creator attribution rather than an
authorization relationship.

Lists also compute `canManageLifecycle` from the caller's lifecycle scope and relationship. This
field is display metadata; lifecycle endpoints perform their own request admission.

### Services and bots

Signed services use the represented canonical actor's role, a hard-coded service capability ceiling,
and a forced `own` session scope. A bot actor therefore needs a D1 creator or participant
relationship even when that actor's built-in Member role contains `read.any` and `collaborate.any`.

This produces a contribution boundary for bot actors that does not exist for browser Members. An
unrelated Slack actor is denied when prompting another actor's session with
`session_access_required`.

No session route currently declares an actorless service grant. Several bot call sites issue
actorless session requests, including Slack attachment/media operations and Linear stop/event
operations. Central route admission rejects such requests with `service_actor_required` before
session relationship evaluation.

### Child sessions

User/service child creation requires `sessions.create` and collaboration on the parent. A parent
sandbox token can create a child through the sandbox capability path without user RBAC.

The child creator is the parent session's active prompt author. Parent access does not automatically
create child access for a different parent creator. User/service child read and cancellation are
authorized against the child, while the parent sandbox path authenticates against the parent and
then checks parent-child lineage in the handler.

## Relevant Workflows

### Browser Member joins an unrelated session

1. Session list is visible through `sessions.read.any`.
2. Session read is admitted without `session_access`.
3. WebSocket-token request is admitted through `sessions.collaborate.any`.
4. The DO creates or updates a participant and rotates its token.
5. The control plane inserts D1 participant access.
6. Subscription rechecks collaboration and grants a five-minute lease.
7. The participant relationship now satisfies Member lifecycle-own and sandbox-access-own.

### HTTP prompt without WebSocket token

1. Prompt request is admitted through `sessions.collaborate.any` for a Member.
2. The DO creates a missing participant and enqueues the prompt.
3. No D1 participant relationship is created by this path.
4. Later lifecycle-own or sandbox-access-own checks still depend on another path having created D1
   access.

### Actor-backed bot contribution

1. The service signature identifies the service and represented actor.
2. The actor's current workspace authorization is loaded.
3. The service ceiling is applied.
4. Session scope is forced to `own`.
5. The actor must already have creator or participant D1 access.

### Administrator lifecycle request without joining

1. `sessions.lifecycle.any` passes router admission without D1 access.
2. Stop, refresh, and retry can proceed without a DO participant check.
3. Title, archive, and unarchive query the DO participant table and return 403 when the identity is
   absent.

## Existing Patterns

- Workspace permissions and session relationships are evaluated in the control-plane router.
- The D1 relationship projection uses canonical workspace user IDs.
- The Session DO participant table owns session-local attribution, SCM metadata, tokens, and
  connection identity.
- Open collaboration is expressed by built-in `*.any` permissions rather than an exception inside
  relationship code.
- Service actors are intentionally narrowed to `own` regardless of their human role's `any` grant.
- Sandbox principals use possession of a session-bound capability instead of workspace RBAC.
- WebSocket authorization is evaluated at subscription and represented by a bounded lease.
- Session list authorization and lifecycle capability are calculated in SQL before results are
  returned.

## Constraints and Invariants

- One canonical user has at most one D1 relationship per session.
- Creator access is not replaced by participant activation.
- Own-scoped deletion and participant management require creator relation.
- Other own-scoped operations accept creator or participant relation.
- Any-scoped operations do not consult `session_access`.
- Actor-backed services cannot use any-scoped session access.
- A sandbox token is valid only for its bound session route.
- Successful WebSocket subscription requires a canonical user identity.
- WebSocket authorization is bounded by a five-minute lease and token use by a 24-hour lifetime.
- D1 and Session DO writes do not share a cross-store transaction.
- User merge preserves the strongest D1 relationship when creator and participant rows collide.

## Known Gaps and Risks

### Relationship and participant divergence

The two stores have different writers and no reconciliation workflow:

- API prompt creates a DO participant without D1 access.
- DO success followed by D1 activation failure leaves a DO participant without D1 access.
- D1 user merge rewrites access but does not update existing DO canonical participant identities.
- There is no participant-removal flow spanning D1, DO tokens, presence, or existing sockets.
- DO `owner/member` and D1 `creator/participant` can disagree.

### Inconsistent lifecycle enforcement

Title, archive, and unarchive require local DO participant existence after router authorization.
Other lifecycle endpoints do not. This makes `sessions.lifecycle.any` behavior dependent on the
specific endpoint and whether the caller previously joined the session.

### Contribution does not uniformly establish access

WebSocket-token contribution establishes D1 participant access; direct HTTP prompting does not. Both
can establish a DO participant.

### Service-call mismatches

Some bot call sites omit actors for routes whose central policy requires one. Package-local tests
mock the control plane and do not cover these calls through real central authorization.

### Documentation drift

The RBAC design includes mutually inconsistent statements about Member visibility. Its role matrix
describes open Member read/collaboration, while other sections describe Member lists as
creator/participant filtered. It also documents participant removal that is not implemented and
states that the DO has no local owner role even though that field remains in schema and runtime
behavior.

### Test coverage boundaries

Existing tests cover scoped permission resolution, relationship checks, list filtering, WebSocket
subscription, service actor isolation, creator-only deletion, and projection writes. No
comprehensive role-by-operation HTTP matrix or end-to-end test of active WebSocket authorization
changes across a lease boundary was found.

## Open Questions

1. Is `session_access` intended to represent durable membership, a capability projection, or only
   the relationship input for `.own` permissions?
2. Is open Member contribution intended to establish membership, or is the relationship created by
   WebSocket-token issuance incidental to the current browser workflow?
3. Is direct HTTP prompt participation intentionally excluded from D1 participant activation?
4. Are the DO participant checks on title, archive, and unarchive intentional authorization or
   residual pre-RBAC behavior?
5. Does actor-backed service isolation intentionally differ from open browser Member collaboration?
6. Are DO `owner/member` roles still part of supported session semantics, or only retained state for
   compatibility and presentation?
7. Was participant removal deliberately excluded from the current product surface?
8. Is parent-to-child access intentionally independent when the active prompt author differs from
   the parent creator?
9. Are the RBAC design documents historical artifacts, living documentation, or a mixture of both?

## Evidence

- `packages/shared/src/rbac.ts`: built-in role permission sets and any-before-own scope resolution.
- `packages/control-plane/src/authorization/session-authorization-policy.ts`:
  operation-to-permission and operation-to-relationship mapping.
- `packages/control-plane/src/routes/shared.ts`: `requireSession` route metadata construction.
- `packages/control-plane/src/router.ts`: active-user, service-ceiling, scoped-permission, and
  relationship enforcement.
- `packages/control-plane/src/db/session-access.ts`: list predicate, exact relationship check, and
  participant activation.
- `terraform/d1/migrations/0071_rbac_foundation.sql`: relationship schema, index, and creator
  backfill.
- `packages/control-plane/src/db/session-index.ts`: creator insertion, own-scoped listing, and
  lifecycle capability projection.
- `packages/control-plane/src/db/session-inbox-store.ts`: inbox visibility and lifecycle capability.
- `packages/control-plane/src/routes/session-ws-token.ts`: public token issuance and D1 participant
  activation.
- `packages/control-plane/src/routes/session-prompt.ts`: collaboration admission and
  principal-derived prompt identity.
- `packages/control-plane/src/session/message-queue.ts`: prompt-created DO participants.
- `packages/control-plane/src/session/schema.ts`: DO participant schema and owner/member role.
- `packages/control-plane/src/session/connection-authenticator.ts`: WebSocket token, canonical user,
  authorization, and token-age checks.
- `packages/control-plane/src/session/websocket-manager.ts`: lease persistence, lookup, and expiry.
- `packages/control-plane/src/session/http/handlers/session-lifecycle.handler.ts`: residual DO
  participant checks for title/archive/unarchive.
- `packages/control-plane/src/authorization/service-permissions.ts`: bot service capability
  ceilings.
- `packages/control-plane/test/integration/rbac-routes.test.ts`: open Member lists and creator-only
  deletion.
- `packages/control-plane/test/integration/websocket-client.test.ts`: any/own collaboration,
  relationship loss, suspension, and assignment failure behavior.
- `packages/control-plane/test/integration/service-auth.test.ts`: actor-backed service relationship
  isolation.
- `packages/control-plane/test/integration/d1-session-index.test.ts`: creator projection, missing
  projection, and lifecycle capability behavior.
- `packages/control-plane/test/integration/user-merge.test.ts`: relationship collision precedence.
- `public/docs/internal/2026-08-28-rbac-design.md`: stated RBAC model and observed documentation
  contradictions.
- Git commit `69d32c6`: changed Member read and collaboration from own to any while retaining the
  relationship projection for narrower operations.
