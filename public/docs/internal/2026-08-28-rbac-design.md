# Design: Role-Based Access Control

**Date:** 2026-08-28

**Status:** Proposed

**Research:** [2026-08-28-rbac-research.md](./2026-08-28-rbac-research.md)

## Summary

Open-Inspect will add workspace-level RBAC to its existing single-installation identity model. Each
canonical human user is assigned exactly one role. A role contains a set of permissions selected
from a code-owned registry. Four protected built-in roles provide safe defaults. The storage and
resolution model also supports existing custom roles, but custom-role creation and editing are
deferred beyond this foundation.

Authorization will be enforced in the control plane after authentication and before business logic.
The web will receive effective permissions for navigation and control affordances, but client checks
will remain advisory. Sessions are workspace-wide resources governed by operation permissions, as
specified in
[Workspace-Wide Session Authorization](./2026-08-30-workspace-wide-session-authorization-design.md).
Bot calls will be limited by both a fixed service capability ceiling and, when acting for a human,
that canonical user's current role.

This design retains one workspace per deployment. It does not add multiple organizations or
per-repository user grants. The SCM App installation continues to define the repository universe;
RBAC determines which application actions a user may perform within that universe.

## Goals

- Assign different capability sets to individual canonical users.
- Provide protected Owner, Administrator, Member, and Viewer roles.
- Resolve and assign persisted custom roles from a fixed permission registry.
- Enforce permissions consistently across HTTP routes, session WebSockets, bots, and settings.
- Distinguish authentication, admission, attribution, resource relationships, and authorization.
- Preserve existing installation access during migration without leaving the workspace ownerless.
- Make role assignment and privileged operations durably auditable.
- Apply role changes promptly to new requests and bounded-lifetime live connections.
- Keep the authorization API explicit, typed, testable, and deny-by-default.

## Non-Goals

- Multiple workspaces or organizations in one deployment.
- User/group grants for individual repositories or environments.
- Synchronizing roles from GitHub, Google, Slack, Linear, or an identity provider.
- Treating source-control permissions as Open-Inspect roles.
- A general policy language, conditional expressions, deny rules, or arbitrary customer-defined
  permission identifiers.
- Billing plans, quotas, approval workflows, or separation-of-duty constraints.
- Modeling Cloudflare, Modal, Terraform, or GitHub deployment operators as application users.
- Changing sandbox-to-control-plane or control-plane-to-Modal machine authentication.
- Making secret values readable after storage.

## Terminology

| Term                  | Meaning                                                                           |
| --------------------- | --------------------------------------------------------------------------------- |
| Workspace             | The singleton administrative boundary represented by one Open-Inspect deployment. |
| Principal             | An authenticated human user, first-party service, or session-bound sandbox.       |
| Actor                 | A provider identity asserted by a bot service on behalf of a human.               |
| Role                  | A named collection of registered permissions.                                     |
| Built-in role         | A protected role shipped by the application with code-defined permissions.        |
| Custom role           | A workspace-defined role composed from registered permissions.                    |
| Permission            | A stable `resource.action` identifier checked by backend policy.                  |
| Relationship          | Context such as automation ownership used alongside a scoped permission.          |
| Capability ceiling    | The maximum permission set a first-party service can exercise.                    |
| Effective permissions | The permissions produced by the current role, bounded by principal policy.        |

## Decisions

| Area             | Decision                                                                                 |
| ---------------- | ---------------------------------------------------------------------------------------- |
| Tenancy          | One implicit workspace per deployment.                                                   |
| User assignment  | Exactly one role per canonical user.                                                     |
| Role model       | Four protected built-ins plus custom roles.                                              |
| Permission model | Fixed allow-only registry owned in shared code. Missing permission denies.               |
| Enforcement      | Control plane is authoritative; web checks are presentation only.                        |
| Resource scoping | Workspace-wide sessions plus contextual own/any automation actions.                      |
| Repository scope | SCM installation defines visibility; role permissions govern app operations.             |
| Services         | Static service ceilings; actor-backed calls use ceiling/actor intersection.              |
| Sandboxes        | Existing session-bound capability model remains separate from human RBAC.                |
| Role changes     | Immediate for HTTP; short authorization leases bound live browser connections.           |
| Audit            | Durable audit events for RBAC changes and sensitive mutations; structured denial logs.   |
| Owner bootstrap  | Every deployment requires an explicit operator bootstrap after the Owner signs in.       |
| Migration        | Existing canonical users become Administrator; the operator explicitly bootstraps Owner. |

## Authorization Model

### Built-in roles

The built-in roles are stable system records. Their names and permission sets are defined in code
and cannot be deleted or edited through the application.

| Role          | Intended capability                                                                           |
| ------------- | --------------------------------------------------------------------------------------------- |
| Owner         | Full application access, role management, member management, and ownership transfer.          |
| Administrator | Full operational access except ownership transfer and protected Owner changes.                |
| Member        | Create and operate sessions and automations; use shared targets; no sensitive administration. |
| Viewer        | Read shared operational state and session output; no launches or shared-resource mutations.   |

Owner is not represented by a wildcard. It receives every registered permission explicitly when
permissions are resolved. This makes newly introduced permissions visible in review and prevents
custom permission strings from becoming executable.

### Custom roles

The data model and permission resolver retain support for persisted custom roles so assignments and
effective authorization do not depend on built-in role keys. This foundation exposes custom roles
through read and assignment APIs only; creating, editing, and deleting them is deferred until there
is a concrete administration workflow. Persisted custom permissions must be registry members, cannot
include `workspace.transfer_ownership`, and remain allow-only without inheritance or deny entries.

One role per user avoids ambiguous permission union, ordering, and deny precedence. A later group or
multi-role system can expand assignment cardinality without changing permission identifiers or route
checks.

### Permission registry

Permissions are exported from `@open-inspect/shared` as stable identifiers and protected built-in
role sets. Built-in policy changes deploy with code and do not require a data migration. Persisted
`role_permissions` rows are the runtime authority only for workspace-defined custom roles. Unknown
identifiers fail role validation and are ignored during effective-permission resolution. Permission
IDs are never reused for different semantics.

### Permission catalog

#### Workspace and identity

| Permission                     | Actions                                                               |
| ------------------------------ | --------------------------------------------------------------------- |
| `workspace.members.read`       | List users, identities, roles, and assignment state.                  |
| `workspace.members.manage`     | Assign roles other than Owner; suspend or restore application access. |
| `workspace.roles.read`         | List role definitions and permission catalog.                         |
| `workspace.transfer_ownership` | Assign/remove Owner while preserving at least one Owner.              |

#### Repositories and environments

| Permission                     | Actions                                                           |
| ------------------------------ | ----------------------------------------------------------------- |
| `repositories.read`            | List installed repositories, branches, and metadata.              |
| `repositories.use`             | Select repositories as session or automation targets.             |
| `repositories.settings.manage` | Change repository SCM, sandbox, and integration overrides.        |
| `repositories.secrets.manage`  | Create, update, or delete repository secrets.                     |
| `repositories.images.manage`   | Toggle or trigger repository image builds.                        |
| `environments.read`            | List and inspect environments and memberships.                    |
| `environments.use`             | Select environments as session or automation targets.             |
| `environments.manage`          | Create, update, or delete environments and repository membership. |
| `environments.settings.manage` | Change environment integration and sandbox overrides.             |
| `environments.secrets.manage`  | Create, update, delete, or import environment secrets.            |
| `environments.images.manage`   | Toggle or trigger environment image builds.                       |

#### Sessions

| Permission                | Actions                                                               |
| ------------------------- | --------------------------------------------------------------------- |
| `sessions.create`         | Create a session using an allowed target.                             |
| `sessions.read`           | Read every workspace session.                                         |
| `sessions.collaborate`    | Prompt, attach files, and connect to every workspace session.         |
| `sessions.lifecycle`      | Rename, archive, unarchive, stop, cancel, and refresh any session.    |
| `sessions.delete`         | Delete any workspace session.                                         |
| `sessions.sandbox_access` | Obtain terminal, VNC, code-server, or sandbox access for any session. |

Session creator and participant data are attribution and runtime identity, not authorization.
Read-state changes require `sessions.read` and always mutate only the caller's own read state.

#### Automations and analytics

| Permission                | Actions                                                                      |
| ------------------------- | ---------------------------------------------------------------------------- |
| `automations.read`        | List automation definitions and run history.                                 |
| `automations.create`      | Create an automation with allowed targets and provider mode.                 |
| `automations.manage.own`  | Edit, pause, resume, rotate keys, or delete automations created by the user. |
| `automations.manage.any`  | Manage any automation.                                                       |
| `automations.trigger.own` | Manually execute an automation created by the user.                          |
| `automations.trigger.any` | Manually execute any automation.                                             |
| `analytics.read`          | View installation-wide session, repository, user, and PR analytics.          |

#### Models, integrations, and execution configuration

| Permission                  | Actions                                                                    |
| --------------------------- | -------------------------------------------------------------------------- |
| `models.preferences.manage` | Change enabled model preferences.                                          |
| `provider_accounts.read`    | View provider account metadata, status, and defaults.                      |
| `provider_accounts.manage`  | Connect, reconnect, rename, verify, enable, disable, and default accounts. |
| `integrations.read`         | View integration, SCM, sandbox, and commit-signing metadata.               |
| `integrations.manage`       | Change global integration and sandbox settings.                            |
| `scm_settings.manage`       | Change deployment-wide SCM settings.                                       |
| `commit_signing.manage`     | Configure or remove deployment-wide signing material.                      |
| `global_secrets.manage`     | Create, update, or delete global secrets.                                  |
| `image_builds.read`         | View repository/environment image build status and history.                |

#### Extensibility

| Permission                  | Actions                                                                   |
| --------------------------- | ------------------------------------------------------------------------- |
| `skills.read`               | List shared managed skills.                                               |
| `skills.manage`             | Import, edit, assign, reimport, enable, disable, or delete shared skills. |
| `skill_profiles.manage_own` | Manage only the caller's skill profiles.                                  |
| `mcp_servers.read`          | List MCP server definitions.                                              |
| `mcp_servers.manage`        | Create, update, or delete MCP server definitions.                         |

Personal keyboard shortcuts and browser-local appearance require only an authenticated, active user.
They do not need role permissions because they cannot affect another user or shared execution.

### Default role matrix

The table groups permissions for readability; the registry stores individual identifiers.

| Capability group                                         | Owner | Administrator |  Member  | Viewer |
| -------------------------------------------------------- | :---: | :-----------: | :------: | :----: |
| Workspace, member, role, and audit read                  |  Yes  |      Yes      |    No    |   No   |
| Manage members                                           |  Yes  |      Yes      |    No    |   No   |
| Transfer Owner role                                      |  Yes  |      No       |    No    |   No   |
| Read repositories and environments                       |  Yes  |      Yes      |   Yes    |  Yes   |
| Use repositories and environments                        |  Yes  |      Yes      |   Yes    |   No   |
| Manage environments/settings/images                      |  Yes  |      Yes      |    No    |   No   |
| Manage global/repository/environment secrets             |  Yes  |      Yes      |    No    |   No   |
| Create sessions                                          |  Yes  |      Yes      |   Yes    |   No   |
| Read any session                                         |  Yes  |      Yes      |   Yes    |  Yes   |
| Collaborate in any session                               |  Yes  |      Yes      |   Yes    |   No   |
| Perform session lifecycle operations                     |  Yes  |      Yes      |   Yes    |   No   |
| Delete sessions                                          |  Yes  |      Yes      |   Yes    |   No   |
| Obtain sandbox access                                    |  Yes  |      Yes      |   Yes    |   No   |
| Read automations                                         |  Yes  |      Yes      |   Yes    |  Yes   |
| Create/manage/trigger automations                        |  Yes  |      Yes      | Own only |   No   |
| Read analytics                                           |  Yes  |      Yes      |    No    |   No   |
| Manage models/provider accounts/integrations/SCM/signing |  Yes  |      Yes      |    No    |   No   |
| Read shared skills and MCP servers                       |  Yes  |      Yes      |   Yes    |  Yes   |
| Manage shared skills and MCP servers                     |  Yes  |      Yes      |    No    |   No   |
| Manage own skill profiles and personal preferences       |  Yes  |      Yes      |   Yes    |  Yes   |

Viewer receives `sessions.read` but no collaborate or lifecycle permission. Member receives every
non-administrative session operation across the workspace. Administrator preserves the existing
broad operational behavior.

## Data Model

### Tables

```sql
CREATE TABLE roles (
  id           TEXT PRIMARY KEY,
  key          TEXT UNIQUE,
  name         TEXT NOT NULL,
  normalized_name TEXT NOT NULL UNIQUE,
  description  TEXT,
  is_system    INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
  CHECK ((is_system = 1 AND key IN ('owner', 'administrator', 'member', 'viewer'))
      OR (is_system = 0 AND key IS NULL))
);

CREATE TABLE role_permissions (
  role_id       TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id TEXT NOT NULL,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE user_role_assignments (
  user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  role_id       TEXT NOT NULL REFERENCES roles(id) ON DELETE RESTRICT
);

CREATE TABLE authorization_audit_events (
  id             TEXT PRIMARY KEY,
  occurred_at    INTEGER NOT NULL,
  request_id     TEXT NOT NULL,
  principal_kind TEXT NOT NULL,
  actor_user_id_snapshot TEXT,
  actor_service_snapshot TEXT,
  action         TEXT NOT NULL,
  resource_type  TEXT NOT NULL,
  resource_id    TEXT,
  target_user_id_snapshot TEXT,
  reason_code    TEXT NOT NULL
);

CREATE INDEX idx_role_assignments_role ON user_role_assignments(role_id, user_id);
```

Built-in roles have stable `key` values: `owner`, `administrator`, `member`, and `viewer`; their
permission sets come from the shared code registry and have no `role_permissions` rows. Custom roles
have `key = NULL`, and their permission rows are the runtime authority. IDs are opaque; role names
are display values. This foundation does not expose custom-role mutations.

`users` gains:

```sql
ALTER TABLE users ADD COLUMN suspended_at INTEGER;
```

Suspension records the time access was disabled without deleting identities or historical
attribution. A null value means the user is active.

Every canonical identity is an active workspace member unless suspended. The RBAC migration seeds
the built-in roles, assigns Administrator to every existing canonical user, and then creates the
default-role trigger. Every identity created afterward receives Member, including identities first
observed through a bot. Identity creation and default role assignment are one database-triggered
workflow. Authorization denies a missing assignment; ordinary sign-in and identity resolution never
repair authorization corruption implicitly.

Initial ownership is assigned only by the root operator CLI after the intended Owner has signed in
once. The operator supplies the canonical user ID, not an email or browser credential. One temporary
SQL file and one Wrangler D1 execution validate the RBAC schema, unsuspended user, exact assignment,
and absence of another unsuspended Owner before atomically writing a redacted `operator-cli` audit
event and assigning `role_builtin_owner`. The final SQL guard verifies the exact generated audit ID
and aborts the operation if the resulting state is inconsistent. Re-running for the current
unsuspended Owner is a no-op and writes nothing. Ownership changes after initialization use the
authenticated member API.

### Storage ownership

- D1 is the source of truth for roles, assignments, status, custom-role grants, and audit events.
- Shared code defines the permission catalog and built-in role grants; persisted permission rows are
  the runtime grant authority for custom roles.
- Session creator attribution remains in D1 and is not an authorization relationship.
- Participant attribution remains in the Session Durable Object for message identity, presence, SCM
  metadata, and WebSocket tokens.
- No role or permission set is copied into sessions, automations, or provider accounts.

## Policy Engine

### Interface

Authorization is invoked through one control-plane service rather than direct role-table queries in
handlers:

```ts
type AuthorizationRequest = {
  principal: Principal;
  permission: PermissionId;
  resource?: AuthorizationResource;
};

type AuthorizationDecision = {
  allowed: boolean;
  reason: AuthorizationReason;
  actorUserId: string | null;
};
```

The engine exposes `requirePermission()` for ordinary checks and an automation resource helper for
owner-scoped automation policy. Denial throws a typed `403` error with a stable reason code.
Authentication failures remain `401`; missing resources remain `404` after permission admission.

### Human decision flow

1. Require an active canonical user.
2. Load the user's role assignment and registered permission set.
3. Deny if no assignment exists.
4. Check the requested permission.
5. For owner-scoped automation permissions, load the automation owner.
6. Return an allow/deny decision with a stable reason.

### Service decision flow

Each service has a code-defined ceiling:

- `web` may proxy browser-auth and discovery operations only; browser application routes authorize
  the human user principal produced by composed authentication.
- `github-bot` may read repository/environment launch metadata, create sessions, read, prompt, or
  stop workspace sessions, and post GitHub automation events.
- `slack-bot` may read launch catalogs/preferences, create sessions, operate sessions mapped to its
  Slack thread, upload/download session media, and post Slack events.
- `linear-bot` may read launch catalogs/preferences, create sessions, and operate sessions mapped to
  its Linear issue/agent session.

For an actor-backed service request:

```text
effective = service ceiling ∩ actor role permissions
```

The actor must resolve to an active canonical user with a role assignment. Service-authenticated
identity enrollment resolves or creates the canonical identity before business authorization and
idempotently assigns the migration default: Administrator for identities captured by the migration,
Member afterward. A first bot interaction can therefore proceed with Member capabilities but can
never claim Owner. Provider webhook verification and GitHub collaborator checks remain additional
admission conditions, never substitutes for application authorization.

Actorless callbacks, normalized webhook events, and automation triggers use narrow service-only
permissions declared for their exact endpoints. They cannot use broad `user-or-service` management
routes.

### Sandbox decision flow

Sandbox authentication remains a scoped capability. A valid sandbox principal can call only route
operations explicitly designated for a sandbox bound to the same session. It does not inherit the
session creator's role and does not gain workspace permissions. Human role changes do not terminate
an executing sandbox, but they can remove human access to its session and controls.

### Session authorization and identity

Session operations are workspace-scoped. A user with a session operation permission may apply it to
every session, regardless of creator or participant identity. Deletion is also workspace-scoped.

`sessions.user_id` retains immutable creator attribution for display, filtering, auditing, and
credential lineage. Session Durable Object participants retain message identity, presence, SCM
metadata, and WebSocket token ownership. Neither is an authorization grant.

Creating a WebSocket token or sending a prompt requires `sessions.collaborate`. WebSocket
subscription rechecks the represented canonical user's active role and collaboration permission.
Private, invitation-only, participant-restricted, and creator-only session behavior is deferred.

### Automation execution authority

Automation definitions retain a canonical owner. Every invocation reauthorizes current state rather
than replaying stored creator authority:

| Trigger      | Initiating actor              | Execution principal    | Required current authority                                                                     |
| ------------ | ----------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------- |
| Manual       | Requesting user               | Requesting user        | own/any trigger, target use, session create                                                    |
| Schedule     | Scheduler service             | Automation owner       | active owner, manage-own, target use, session create                                           |
| Webhook key  | Narrow webhook capability     | Automation owner       | active owner, manage-own, target use, session create                                           |
| Sentry       | Verified Sentry webhook       | Automation owner       | active owner, manage-own, target use, session create                                           |
| GitHub event | Verified GitHub service actor | Canonical GitHub actor | service ceiling; active actor with session create and target use; active owner with manage-own |
| Slack event  | Verified Slack service actor  | Canonical Slack actor  | service ceiling; active actor with session create and target use; active owner with manage-own |
| Linear event | Verified Linear service actor | Canonical Linear actor | service ceiling; active actor with session create and target use; active owner with manage-own |

The resulting session is owned by and attributed to the named canonical execution principal. The
initiator, service, and automation owner are recorded separately in invocation/audit metadata. Skill
profiles and user-linked credentials come from the execution principal; installation-wide secrets
and provider accounts remain selected by the automation's current allowed configuration. A manual
trigger never runs as another user's stored identity. Loss of any conjunctive authority marks the
invocation `skipped_authorization` without launching a session. Repeated scheduled or webhook
authorization failures pause the automation after the existing failure threshold and notify
administrators. Provider-account and secret resolution is repeated under the current execution
policy.

New automations require an active canonical owner. Historical automations with missing or unresolved
owners are disabled during migration and require explicit reassignment by an Administrator or Owner
before execution.

## Route Enforcement

### Route metadata

Authentication policy remains responsible for proving principal kind. Every route declaration also
contains required authorization metadata. Static permission routes declare the permission beside the
method and pattern:

```ts
authorization: requirePermission("environments.manage");
```

Session routes identify the operation applied to the already-matched path parameter. Conjunctive
policies list every requirement explicitly:

```ts
authorization: requireAll(
  permissionRequirement("sessions.create"),
  permissionRequirement("sessions.collaborate")
);
```

The router executes declared permission, session-operation, and automation checks before handlers.
Request admission uses current authorization; a concurrent role change does not retroactively revoke
an admitted HTTP request. Personal active-user routes, active global routes, public routes, and
service-only callbacks each use an explicit policy kind; narrow internal callbacks name their exact
service. `router.policy.test.ts` rejects missing metadata, duplicate method/pattern pairs,
incompatible authentication/authorization combinations, and session requirements that reference
absent match groups.

### Exemptions

Only these ingress/authentication classes bypass browser authentication:

- public health;
- browser-auth protocol endpoints;
- externally authenticated webhook ingress;
- image-build capability callbacks;
- session-bound sandbox routes;
- narrow internal service callbacks.

Each exemption names its alternate ingress mechanism in route metadata. Webhook authenticity permits
normalization/queueing only; every resulting automation or resource operation still applies the
execution-authority policy before side effects. `user-or-service` alone is never sufficient
authorization after this change.

A generated route-to-policy inventory covers every session, child-session, attachment, media, diff,
pull-request, credential, automation, secret, settings, and callback endpoint. Sandbox child
operations remain parent-session-bound; human child operations use workspace session permissions.

### Listing and filtering

Authorization applies before list queries, with contextual automation ownership applied in SQL where
needed.

- Every user with `sessions.read` receives the workspace session list.
- Creator and Mine filters use `sessions.user_id` as attribution, not access control.
- Automation lists use `manage.any/read` or creator ownership as appropriate.
- Resources requiring a missing read permission are omitted from catalogs and navigation.
- Repository/environment catalogs require read permission; use permission is separately checked when
  launching or configuring an execution target.

## API Contracts

### Current user authorization

`GET /me/authorization` returns:

```json
{
  "userId": "canonical-id",
  "suspendedAt": null,
  "role": { "id": "role-id", "key": "member", "name": "Member" },
  "permissions": ["repositories.read", "sessions.create"]
}
```

This endpoint is available only to the current browser user. Responses are private and no-store.

### Role administration

| Method | Path         | Permission             | Purpose                              |
| ------ | ------------ | ---------------------- | ------------------------------------ |
| `GET`  | `/roles`     | `workspace.roles.read` | List roles, counts, and permissions. |
| `GET`  | `/roles/:id` | `workspace.roles.read` | Read one role and permissions.       |

### Member administration

| Method | Path                      | Permission                             | Purpose                               |
| ------ | ------------------------- | -------------------------------------- | ------------------------------------- |
| `GET`  | `/members`                | `workspace.members.read`               | List canonical users and assignments. |
| `PUT`  | `/members/:userId/role`   | `workspace.members.manage` or transfer | Replace one assignment.               |
| `PUT`  | `/members/:userId/status` | `workspace.members.manage`             | Suspend or restore access.            |

Owner assignment or removal requires `workspace.transfer_ownership`, including when the caller also
has member-management permission. Suspending, deleting, or merging an Owner also requires transfer
permission. Every role/status/delete/merge mutation uses guarded SQL that succeeds only if another
unsuspended Owner remains in the same D1 batch. User deletion is blocked by assignment
`ON DELETE RESTRICT`; the assignment can be removed only through this guarded membership service.
User merge requires an explicit surviving assignment, repoints canonical session creator
attribution, and preserves both immutable audit snapshots.

Assignment and status updates apply the request-scoped authorization decision and preserve Owner
invariants in the same D1 batch as the mutation. Authorization changes do not retroactively revoke
an already admitted request.

### Error contract

Forbidden API responses use:

```json
{
  "error": "Forbidden",
  "code": "permission_required",
  "permission": "environments.manage"
}
```

Other denials use codes such as `active_user_required` and `service_capability_required`. Responses
do not disclose another user's role.

## Web Experience

### Authorization state

The app shell loads current authorization with the browser session. It distinguishes:

- unauthenticated;
- authenticated but suspended/unassigned;
- authenticated and authorized;
- authorization service unavailable.

Permission checks consume the stable `hasPermission` predicate from the current-user authorization
hook. They hide navigation that has no readable content and disable contextual controls when
explaining the missing capability is useful. Server-rendered session pages authorize before fetching
snapshots.

### Members and roles

A Workspace settings section contains:

- Members: identity, provider links, status, role, last activity, and assignment actions.
- Roles: built-in/custom roles, assignment count, and categorized permission details.
- Audit log: actor, action, target, outcome, reason, and timestamp.

The UI prevents removing the last unsuspended Owner and assigning Owner without transfer permission.
The API repeats every invariant.

### Existing navigation

- Settings tabs appear only when at least one permission makes them useful.
- New session requires `sessions.create` plus target `use` permission.
- All/Mine becomes All/My sessions; both are filters over the workspace-wide session list.
- Session controls reflect read, collaborate, lifecycle, delete, and sandbox-access permissions
  independently.
- Analytics requires `analytics.read`.
- Automation create/manage actions are independent from automation read access.

The browser never treats hidden controls or downloaded permissions as security enforcement.

## Audit and Observability

Durable audit events are required for:

- user role assignment;
- access suspension/restoration;
- Owner assignment/removal;
- secret, provider-account, commit-signing, integration, SCM, MCP, and shared-skill mutations;
- allowed and denied member-management operations.

Pure D1 mutations write the audit event in the same D1 batch.

High-volume ordinary reads and successful session messages remain in structured request logs rather
than D1 audit storage. Every authorization denial logs principal kind, actor user ID when known,
permission, policy, resource type, opaque resource ID, reason code, request ID, and service name.
Secret values, OAuth credentials, prompt content, and signed tokens never enter audit metadata.

Metrics include denial count by permission/reason/principal, unassigned active users, assignment
count by role, and authorization latency.

## Role Changes and Revocation

- HTTP requests load current assignment/status and apply changes immediately.
- Role permission edits take effect on the next authorization lookup.
- Browser WebSocket credentials are bound to the canonical user. Subscribe verifies current D1
  authorization and rejects missing or suspended users, missing role assignments, and unavailable
  authorization storage.
- A successful subscribe asks the WebSocket manager to grant a five-minute wall-clock authorization
  lease. The manager persists its expiry in `ws_client_mapping` and owns earliest-expiry scheduling
  in the unified alarm. On expiry the browser clears its credential and reconnects through the
  authorized HTTP token route.
- Alarm and hibernation restoration close every expired connection even when it is idle. Every
  inbound event and outbound broadcast also rejects expired leases as defense in depth. A role
  change therefore revokes live browser access within the five-minute wall-clock lease bound.
- Bot calls authorize on every signed HTTP request. Stale Slack/Linear issue mappings do not bypass
  current policy.
- Suspending a user invalidates Better Auth sessions.
- Existing sandboxes continue running because their credentials represent the session runtime, not
  the user. Users who lose lifecycle permission cannot reconnect or control them.

## Migration and Compatibility

The migration is additive and preserves current capability for every canonical user:

1. Create role, permission, assignment, and audit tables.
2. Insert protected built-in role records; their permission sets remain code-owned.
3. Assign Administrator to every canonical user present in `users`, including identities originally
   created through Slack, GitHub, or Linear.
4. Create the unconditional default-role trigger. Identity provisioning after this point assigns
   Member.

No route switches to enforcement until every existing canonical user has an Administrator assignment
and built-in role reconciliation succeeds. Administrators may continue using the application before
Owner bootstrap. After deployment, the intended Owner signs in once to create a canonical user and
assignment. An operator then dry-runs and executes the root CLI against that canonical ID. Sign-in
and bot identity creation never assign Owner.

Deployment documentation will state that Administrator preserves the previous installation-wide
operational behavior, while Member becomes the default for newly admitted users.

### Operator bootstrap

Terraform exports the D1 database name but does not configure an Owner identity. The supported
sequence is deploy, have the intended Owner sign in once, obtain the canonical ID from the browser
session, run `npm run rbac:bootstrap-owner -- --database <name> --user <id>`, review the dry-run
preflight, rerun with `--execute`, and verify `/health` reports `rbac.ownerAssignment=present`.

When an unsuspended Owner assignment exists, `/health` reports `rbac.ownerAssignment=present`; when
none exists, it reports `missing`. Administrators and Members can use their existing capabilities,
but no one can exercise Owner-only actions.

## Failure Handling

- D1 authorization lookup failure denies the request and returns `503 authorization_unavailable`; it
  never falls back to broad authenticated access.
- Missing or unknown role permissions deny and emit a reconciliation error.
- Missing user assignment denies shared application routes but permits sign-out and own identity
  discovery so an administrator can repair access.
- Audit-write failure aborts transactional D1 administration.
- Web authorization metadata failure renders an unavailable state rather than the unrestricted app.

## Security Invariants

1. Authentication never implies authorization.
2. Admission allowlists never imply a role beyond bootstrap/default assignment.
3. Unknown permissions, missing assignments, suspended users, and policy errors deny access.
4. Client-side permission checks are never authoritative.
5. Creator and participant attribution are not authorization checks.
6. A service cannot exceed its code-defined ceiling.
7. An actor-backed service cannot exceed the linked user's current permissions.
8. An actorless service can execute only exact service-only operations.
9. Sandbox credentials remain bound to one session and confer no workspace role.
10. Before bootstrap, no user can exercise Owner-only actions; after bootstrap, at least one
    unsuspended Owner always exists.
11. Only an Owner can add or remove Owner assignments.
12. Role changes and privileged mutations produce durable, redacted audit events.
13. Session lists require workspace read permission before returning metadata.
14. Secret-management permission never makes stored secret values readable.
15. External provider authorization is additional evidence, not a replacement for application RBAC.

## Testing Strategy

### Shared

- Permission registry uniqueness and stable serialization.
- Built-in role snapshots and persisted custom-role resolution.
- API schema rejection of malformed role responses and assignments.

### Control-plane unit

- Human permission allow/deny matrix for every built-in role.
- Custom role resolution, suspension, missing assignment, and unknown permission behavior.
- Workspace-wide session operation permissions for every built-in role.
- Service ceiling and actor intersection for every bot.
- Actorless exact-endpoint service permissions.
- Last-Owner, built-in-role, assignment, and transaction invariants.
- Concurrent Owner demotion/suspension/delete and user-merge conflicts.
- Stable `401`, `403`, `404`, and `503` behavior.
- Route policy completeness requiring authorization metadata or named exemption.

### Control-plane integration

- Multi-user tests proving permitted Members can read, collaborate, manage lifecycle, access the
  sandbox, and delete across workspace sessions.
- Viewer can read but cannot prompt, launch, stop, delete, or access sandbox credentials.
- Administrator can operate installation-wide resources but cannot transfer Owner.
- Owner can assign roles without removing the last unsuspended Owner.
- Secret/settings/provider-account/skill/MCP/image routes enforce individual permissions.
- Session lists remain workspace-wide while creator and Mine filters preserve attribution semantics.
- Role changes are enforced when idle, active, hibernated, and multi-tab WebSocket authorization
  leases expire.
- Suspended browser sessions and bot actors are denied.
- D1 failure fails closed and audit failure aborts protected mutations.
- Automation schedule, webhook, event, and manual triggers reauthorize the correct execution
  principal after owner suspension, demotion, role edit, and target-access loss.
- Sentry, GitHub, Slack, and Linear trigger tests assert session owner, initiator audit fields,
  owner guard, service ceiling, actor permission intersection, and credential/profile source.

### Web

- Navigation and controls for Owner, Administrator, Member, Viewer, custom, suspended, and
  unavailable states.
- Direct URL access remains denied when navigation is hidden.
- Session server rendering does not fetch unauthorized snapshots.
- Workspace member controls enforce API invariants.
- Generic forbidden responses do not trigger sign-in flows.

### Bots

- Each service can call only its ceiling routes.
- Linked actor role is required for actor-backed launches and prompts.
- Unlinked, suspended, and underprivileged actors fail closed with user-safe provider responses.
- Existing GitHub collaborator, Slack webhook, and Linear organization checks remain enforced.
- External session mappings cannot bypass actor role or service ceiling checks.

### Migration

- Empty installation assigns Member to new identities and requires an explicit canonical-ID operator
  bootstrap for the initial Owner.
- Existing installation assigns every pre-migration canonical user Administrator, including bot-only
  identities, then requires the same explicit operator bootstrap.
- Every canonical user receives exactly one assignment.
- Built-in role reconciliation is idempotent and rejects incompatible registry drift.
- Exact migration SQL executes under workerd/D1, including indexes and constraints.
- Better Auth or bot identity creation followed by assignment failure cannot enter business routes
  and retries Member assignment idempotently.
- Owner bootstrap requires an existing unsuspended canonical user with exactly one assignment and
  refuses another unsuspended Owner.
- CLI bootstrap is atomic and idempotent, writes exactly one redacted operator audit event on a
  ready transition, and writes nothing when the target is already the current Owner.

## Alternatives Considered

### Role column on `users`

Rejected because it cannot represent custom role metadata and permission composition without
hard-coding authorization throughout handlers.

### Multiple roles per user

Rejected for the initial system because role union and future deny semantics add complexity without
a current user requirement. One assignment directly matches user-level role configuration.

### Per-repository and per-environment grants

Deferred because current deployment identity and repository discovery are installation-wide. Adding
resource grants would require group semantics, environment membership rules, bot grant mapping, and
SCM synchronization decisions not resolved by current product behavior.

### Encode permissions in browser sessions

Rejected because role changes would remain stale for the Better Auth session lifetime and backend
handlers would still need authoritative policy state.

### Use Session Durable Object participant roles as application RBAC

Rejected because those roles exist only inside one session, are auto-created by current workflows,
and cannot govern installation settings or repository/environment actions.

### External policy engine

Rejected because the initial policy consists of a small fixed permission registry plus contextual
automation ownership. D1 and typed control-plane policy keep the trust boundary and operational
footprint within the existing architecture.

## Open Product Decisions

The design chooses defaults for implementation, but product confirmation is required before
enforcement:

1. Session operations are workspace-wide when granted by the user's role.
2. New canonical users default to Member after the RBAC migration boundary.
3. Administrator receives all operational permissions except ownership transfer.
4. Persisted custom roles cannot receive ownership transfer.
5. Repository and environment access remains installation-wide rather than user-granted.
6. Existing users are promoted to Administrator to preserve current access.
7. Executing sandboxes continue after their creator is suspended or demoted.
8. Authorization audit events are retained under the deployment's existing D1 retention policy.
9. Scheduled/webhook automations stop launching when their owner loses current execution authority.
10. Session creator and participant identities are attribution, not authorization.
11. Five minutes is a strict wall-clock browser WebSocket revocation bound, including idle sockets.
