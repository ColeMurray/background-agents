# Design: Workspace-Wide Session Authorization

**Date:** 2026-08-30

**Status:** Accepted

**Research:** [2026-08-30-session-access-research.md](./2026-08-30-session-access-research.md)

## Summary

Open-Inspect sessions are workspace-wide resources. An active user may perform an operation on every
session when their workspace role grants that operation. Session creator and participant
relationships do not grant, narrow, or revoke authorization.

Session authorization uses unscoped operation permissions. Actor-backed bot requests intersect the
represented user's current role with the bot service's fixed capability ceiling, without applying a
session relationship check.

Creator attribution, participant identity, sandbox capability binding, and WebSocket authorization
remain supported concerns, but none is a session access-control list.

## Context

Before workspace RBAC, authenticated users could operate across sessions without a creator or
participant authorization boundary. The RBAC foundation introduced `.own` and `.any` session
permission pairs and a D1 `session_access` projection. Built-in Members still received
workspace-wide read and collaboration, while lifecycle, sandbox access, deletion, participant
management, and bot requests became relationship-dependent.

That partial relationship model does not match the product's multiplayer behavior. It also creates
two inconsistent participant stores: D1 relationships used for authorization and Session Durable
Object participants used for message identity, presence, SCM metadata, and WebSocket tokens.
Different contribution paths update those stores differently.

## Decisions

### Workspace-wide operations

Session permissions are operation permissions without resource scope:

- `sessions.read`
- `sessions.collaborate`
- `sessions.create`
- `sessions.lifecycle`
- `sessions.sandbox_access`
- `sessions.delete`

A granted session operation applies to every session in the workspace. No route or WebSocket
authorization check consults creator or participant relationships.

Deletion is workspace-scoped. Creator-only deletion is explicitly deferred and is not part of this
RBAC change.

### Built-in roles

Built-in roles distinguish which operations a user may perform, not which sessions they may target:

| Role          | Session behavior                                                                    |
| ------------- | ----------------------------------------------------------------------------------- |
| Owner         | Every session operation across the workspace.                                       |
| Administrator | Every session operation across the workspace.                                       |
| Member        | Create, read, collaborate, manage lifecycle, access sandboxes, and delete sessions. |
| Viewer        | Read every session; no create, collaborate, lifecycle, sandbox, or delete access.   |

Custom roles may contain any registered session operation permission. Custom roles cannot express
private, invitation-only, creator-only, or participant-only session access.

### Actor-backed services

A bot service acting for a human uses the intersection of two operation sets:

```text
effective operations = actor role permissions intersect service capability ceiling
```

The represented actor must resolve to an active canonical workspace user. The service cannot exceed
the actor's role or its own ceiling. If both grant `sessions.collaborate`, the actor may collaborate
on any session, including a session created by another user. This preserves multiplayer Slack,
GitHub, and Linear workflows.

Actorless service calls remain limited to narrow route-specific grants.

### Creator attribution

`sessions.user_id` records the canonical user responsible for creating a session. It supports
display, filtering, auditing, credential selection, automation lineage, and other attribution needs.
It is not an authorization relationship.

The `Mine` session-list filter continues to select sessions by creator attribution. It is a user
filter, not an access boundary.

### Participant identity

Session Durable Object participants identify message authors and connected clients. They may retain:

- provider identity and canonical user linkage;
- display and SCM metadata;
- message attribution;
- presence identity;
- WebSocket token ownership.

Participant existence and the persisted `owner` or `member` value do not authorize session
operations. Joining or contributing to a session does not create a separate authorization grant.

Participant-management APIs that exist only to maintain access-control relationships are removed.
Runtime participant creation required for attribution remains internal to contribution and
WebSocket-token flows.

### WebSockets

WebSocket token issuance and subscription require an active canonical user with
`sessions.collaborate`. Tokens remain bound to their session and participant identity. Subscription
authorization is rechecked through bounded leases so suspension or role changes affect live access.

The authorization recheck evaluates active workspace membership and `sessions.collaborate`; it does
not evaluate creator or participant access records.

### Sandbox capabilities

Human or actor-backed requests for sandbox credentials require `sessions.sandbox_access`, which
applies workspace-wide. Sandbox-originated control-plane requests continue to authenticate with a
session-bound sandbox capability and remain restricted to that session.

Human workspace authorization and sandbox capability binding are separate security boundaries.

### Lifecycle and state checks

Lifecycle routes require `sessions.lifecycle` for every session. Session state-machine checks,
queued-work checks, and sandbox runtime constraints continue to apply.

Durable Object participant existence is not a lifecycle authorization condition. Rename, archive,
and unarchive follow the same workspace permission policy as stop, retry, and refresh.

### Service and UI metadata

Session lists are not filtered by authorization relationships. Query filters such as creator and
status remain supported.

The web client derives lifecycle-control visibility from the current user's workspace
`sessions.lifecycle` permission. Session list and inbox responses contain session data, not
authorization presentation metadata; lifecycle endpoints remain authoritative.

## Removed Model

The RBAC foundation does not include:

- a D1 `session_access` table;
- creator or participant authorization projections;
- `.own` and `.any` session permission pairs;
- relationship-filtered session or inbox queries;
- relationship activation during WebSocket token issuance;
- relationship-aware user merge behavior;
- creator-only deletion or participant management;
- bot-specific narrowing to sessions associated with the represented actor.

Because this schema and permission model were introduced on the unshipped RBAC branch, they are
removed directly from the branch migration and permission registry rather than retained as a
compatibility layer.

## Deferred Features

Private, invitation-only, creator-restricted, or participant-restricted sessions require a separate
product design. Such a design must address visibility, invitations, removal, revocation, historical
participants, bot behavior, parent-child sessions, cross-store consistency, migration, and UI.

No relationship schema or permission identifiers are retained speculatively for that future work.

## Invariants

- A workspace permission has the same meaning for browser users and represented bot actors.
- A service may narrow an actor's operations but may not expand them.
- Session creator and participant data are attribution and runtime identity, not authorization.
- Every user with `sessions.read` can read and list every session.
- Every user with `sessions.collaborate` can contribute to every session.
- Every user with `sessions.lifecycle` can invoke lifecycle operations on every session.
- Every user with `sessions.sandbox_access` can request sandbox access for every session.
- Every user with `sessions.delete` can delete every session.
- Sandbox credentials remain bound to one session regardless of human workspace permissions.
- Suspension and role changes apply to new HTTP requests and bounded-lifetime WebSocket leases.

## Verification

The implementation must cover:

- a role-by-operation HTTP authorization matrix;
- cross-user browser collaboration;
- cross-user actor-backed bot listing and collaboration;
- service ceiling denial when the actor role permits an operation the service does not;
- Viewer read access and mutation denial;
- workspace-wide lifecycle, sandbox, and deletion behavior for permitted roles;
- WebSocket subscription reauthorization after role or suspension changes;
- session-bound sandbox authentication;
- lifecycle consistency across rename, archive, unarchive, stop, retry, and refresh.
