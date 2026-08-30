# Research: Role-Based Access Control

**Date:** 2026-08-28

**Status:** Superseded research snapshot

**Scope:** Current identity, authentication, authorization, resources, actions, storage, user
workflows, service integrations, and operational trust boundaries relevant to application RBAC.

The implemented model is documented in [Role-Based Access Control](./2026-08-28-rbac-design.md).

This document is intentionally research-only. It does not include recommendations, implementation
plans, proposed code/API/schema changes, task breakdowns, estimates, or rollout steps.

## Summary

Open-Inspect authenticates human users, first-party services, and session-bound sandboxes, but it
does not have an application role, workspace membership, permission, grant, or administrator model.
The deployment is explicitly single-tenant: admission policy determines who may sign in, and an
admitted human generally shares installation-wide access to repositories, sessions, environments,
secrets, settings, provider accounts, automations, skills, MCP servers, image controls, and
analytics.

Human identity is canonicalized across GitHub, Google, Slack, and Linear. First-party bots sign
requests as distinct services and may assert actors in their own provider namespace. Sandboxes use
credentials bound to one session. These principal distinctions constrain authentication channels,
but most route policies do not distinguish capabilities among admitted humans or among signed bot
services.

Sessions contain `owner` and `member` participants, but those roles are not a general authorization
boundary. Session creator fields primarily support attribution and filtering. Existing visibility
logic deliberately returns any session in the installation, and authenticated users or services can
join, prompt, inspect, stop, or mutate many sessions without an owner check.

The application has three broad resource scopes today: per-user preferences, session-scoped runtime
state, and installation-wide operational resources. Repository and environment resources do not have
application membership or grant records. External source-control permissions are consulted in some
GitHub bot trigger paths, but ordinary web and service access uses the deployment's SCM App or token
authority.

## Research Questions

1. Which identities and authentication channels exist today?
2. Which application resources and actions would intersect with authorization decisions?
3. Which resources are personal, session-scoped, repository/environment-scoped, or
   installation-wide?
4. Where are authorization decisions currently made, and what do they enforce?
5. How do Slack, GitHub, Linear, sandboxes, and deployment operators cross trust boundaries?
6. Which current fields represent attribution rather than ownership or access?
7. Which gaps and unresolved product semantics affect an RBAC design?

## Current Behavior

### Human identity and admission

- Canonical users are stored in D1 `users`; provider identities are stored in `user_identities` and
  linked by canonical user ID.
- Browser sign-in supports GitHub and Google through Better Auth. Browser requests reach the control
  plane through a signed `service:web` channel and a valid browser session cookie.
- Admission supports GitHub login, email, email domain, and GitHub organization allowlists, plus an
  explicit unsafe allow-all mode. Admission only controls sign-in eligibility.
- The browser session contract exposes user ID, name, email, and image. It has no role, permission,
  membership, workspace, or resource-grant data.
- Canonical user IDs currently scope keyboard shortcuts, managed-skill profiles, session read state,
  temporary provider-account authorization transactions, and the session-list `Mine` filter.

### Request principals and route policies

The control plane resolves every authenticated request to one of:

| Principal           | Identity boundary                         | Current use                                        |
| ------------------- | ----------------------------------------- | -------------------------------------------------- |
| Human user          | Canonical user ID                         | Browser-originated application requests            |
| First-party service | Service name plus optional asserted actor | Web, Slack, GitHub, and Linear Workers             |
| Sandbox             | Session ID                                | Session runtime callbacks and credential brokerage |

Route authentication distinguishes public, handler-authenticated, web-service, human-user,
user-or-service, sandbox, and sandbox-fallback requests. It does not express application actions,
resource scopes, user roles, or grants. Human-only routes exclude bots but admit every authenticated
human. Most `user-or-service` routes admit every signed first-party service, not a named subset.

### Session visibility and participation

- Session creation stores a canonical creator in the D1 session index and creates a Durable Object
  participant with role `owner`.
- Other identities are added as `member` participants when they request a WebSocket token or send a
  prompt.
- `SessionIndexStore.getVisibleForUser()` deliberately ignores the supplied user ID and returns any
  existing session. Its source comment names this the single-tenant visibility boundary.
- Session lists are global unless `createdBy=me` is supplied as an explicit filter.
- Session title, archive, and unarchive handlers require participation, but do not distinguish
  `owner` from `member`. Other lifecycle and runtime routes do not consistently require existing
  participation.
- An authenticated user or asserted service actor can request a WebSocket token for a session and be
  added as a member. Prompt submission follows the same auto-membership pattern.
- Deletion, stop, event, artifact, media, attachment, participant, pull-request, and other session
  operations generally rely on route authentication and a supplied session ID rather than creator or
  participant ownership.
- Sandbox credentials are verified against the Session Durable Object and cannot authenticate to a
  different session. Child-sandbox fallbacks are also bound to their parent session.

### Installation-wide resources

The following resources are shared across admitted users in the current deployment model:

| Resource                 | Read actions                                | Mutation or execution actions                                |
| ------------------------ | ------------------------------------------- | ------------------------------------------------------------ |
| Repository catalog       | List repositories, branches, metadata       | Use as session/environment/automation targets                |
| Global secrets           | List key metadata                           | Create/update/delete values                                  |
| Repository secrets       | List key metadata                           | Create/update/delete values                                  |
| Environments             | List/view                                   | Create/update/delete; manage repositories and branches       |
| Environment secrets      | List key metadata                           | Create/update/delete/import values                           |
| Integration settings     | View global/repository/environment settings | Enable, update, override, reset                              |
| SCM and sandbox settings | View configuration                          | Update/reset defaults and overrides                          |
| Model preferences        | View enabled models                         | Change installation-wide model visibility                    |
| Provider accounts        | List/status                                 | Connect, reconnect, rename, verify, enable, disable, default |
| Automations              | List/view runs                              | Create, edit, trigger, pause, resume, delete, rotate key     |
| Managed shared skills    | List/view                                   | Import, edit, assign, reimport, delete                       |
| MCP servers              | List/view                                   | Create, edit, delete commands, headers, and environment      |
| Image builds             | View status/feed                            | Toggle prebuilds, trigger builds                             |
| Commit signing           | View metadata                               | Configure/update/delete signing material                     |
| Analytics                | View installation aggregates                | No primary mutation workflow                                 |

Environments have no owner, member, team, role, or ACL columns. Repository access is based on the
deployment's SCM App installation or configured token. Generic settings and secret stores are not
keyed by user. Provider-account creator/updater IDs and automation creator fields record attribution
but do not restrict later access.

### Personal and local resources

- Keyboard shortcut preferences are stored by canonical user ID.
- Managed-skill profiles are associated with a canonical user, while the shared skill catalog is
  installation-wide.
- Session read states are stored by `(user_id, session_id)` but rely on the broad session visibility
  boundary.
- Provider-account device-authorization transactions are user-scoped while in progress; completed
  provider accounts are installation-wide.
- Appearance and syntax preferences are browser-local.
- Slack and Linear bot preferences are provider-user-scoped in their Workers' KV stores.

### Web application behavior

- `AppAuthBoundary` gates the application shell on authentication state only.
- The sidebar exposes new session, all/mine sessions, settings, automations, analytics, and archived
  sessions to every authenticated user.
- Settings navigation is identical for all authenticated users except for deployment-capability
  checks such as repository-image support.
- Session controls react to lifecycle, connection, and loading state, not participant role.
- No client condition was found for an administrator flag, role, permission list, repository grant,
  environment membership, session owner role, or creator equality.
- The client does not currently represent an authenticated-but-forbidden state distinct from sign-in
  admission denial, aside from generic API errors.

## Relevant Workflows

### Browser request

1. GitHub or Google OAuth establishes a Better Auth browser session.
2. The Next.js server signs the control-plane request as `service:web` and forwards the browser
   cookie.
3. The control plane verifies both channel and browser identity and creates a user principal.
4. The route policy checks principal kind and SCM compatibility.
5. The handler reads or mutates the requested resource; most handlers have no additional user-level
   access check.

### Bot-created session

1. A bot verifies an external Slack, GitHub, or Linear webhook.
2. The bot signs a control-plane request with its per-service secret and may assert the external
   actor in its namespace.
3. The control plane verifies the service and actor namespace, resolves or creates a canonical user,
   and derives session identity from the principal.
4. Session creation requires an actor-backed participant. Existing-session prompts may be actorless
   and are then attributed to `anonymous`.
5. The selected repository or environment is resolved using deployment-wide catalogs and
   credentials. GitHub trigger flows additionally enforce configured allowlists or GitHub
   write-level collaborator permissions; Slack and Linear do not perform equivalent SCM-user checks.

### Session collaboration

1. A browser or bot addresses a session by ID.
2. A WebSocket-token or prompt request can create a `member` participant automatically.
3. The Session Durable Object stores participants, messages, artifacts, diffs, repositories, sandbox
   state, and credentials.
4. Participant role is returned in shared session types, but the web does not consume it as an
   authorization signal.

### Sandbox runtime

1. The control plane creates and hashes a per-session sandbox token.
2. The token and session configuration are injected into the sandbox.
3. Sandbox requests are authenticated against the session ID in the route.
4. Session-bound routes broker SCM credentials, provider access, commit signing, skills,
   attachments, and runtime events.
5. The sandbox is not represented as a human role and cannot authenticate outside its bound session
   through the sandbox credential.

### Deployment and data plane

1. GitHub Actions and Terraform provision Cloudflare, D1, R2, Workers, service secrets, and Modal.
2. Deployment operators hold authority outside the application's principal model through source
   control, GitHub environments, Cloudflare, Terraform state, Modal, and SCM App installation
   access.
3. The control plane authenticates to Modal with a deployment-wide HMAC secret.
4. Modal trusts possession of that secret for authenticated endpoints and does not receive the
   initiating application user, role, or resource grants.

## Existing Patterns

### Central authentication composition

The router attaches a verified principal before authenticated handlers run. Route definitions carry
typed authentication policy, and policy-completeness tests assert that every route declares one.

### Canonical cross-provider identity

Browser and bot identities converge on a canonical D1 user while retaining provider identity and
participant identity. Body-supplied identity and credential fields are rejected for
identity-sensitive routes.

### Session-bound capabilities

Sandbox tokens, image-build callback tokens, and browser participant WebSocket tokens are scoped to
specific runtime resources rather than functioning as installation-wide human credentials.

### Provider and scope registries

Repositories use shared identity helpers, environments have opaque IDs and ordered repository
membership, image builds use explicit repository/environment scope kinds, and integration settings
already resolve global, repository, and environment levels.

### Attribution without authorization

Sessions, automations, provider accounts, skills, and logs record creators or actors. Existing code
and design documents explicitly distinguish these fields from ownership checks.

### Denial and audit behavior

Authentication failures use `401`; principal-kind failures use `403`. Some sensitive workflows,
including managed skills and Slack notification, emit structured audit logs. There is no complete,
durable application authorization audit ledger.

## Constraints and Invariants

- TypeScript and Python use milliseconds and seconds respectively for durations.
- Shared contracts are consumed by control plane, web, and bot packages and are built first.
- D1 is the installation-wide relational store; each Session Durable Object has separate SQLite
  state and is not directly joinable with D1 during an in-object operation.
- Route authentication happens before handler execution; handler-authenticated webhooks apply their
  own provider or capability checks.
- Browser requests must retain both a signed web-service channel and a valid browser session.
- Bot actors can only be asserted by their owning first-party service namespace.
- Caller-supplied identity fields are rejected where verified principal identity is required.
- Sandbox credentials remain session-bound and session provider-auth choices are immutable after
  creation.
- Repository owners may contain nested path segments; repository identity helpers split on the last
  slash and preserve the complete owner.
- Environment sessions snapshot repository membership; later environment changes do not alter
  existing sessions.
- Secrets are encrypted at rest and values are not returned by list operations, but authorization to
  manage their ciphertext and metadata is installation-wide.
- The Modal API receives a deployment credential, not end-user identity; application authorization
  currently terminates at the control plane.
- Existing admitted users have broad access under documented single-tenant semantics.

## Known Gaps and Risks

- No role, membership, grant, group, workspace, or administrator records exist in D1.
- No authorization action vocabulary or resource-scope vocabulary exists in shared contracts.
- Route policies conflate authentication channel, principal kind, SCM support, and broad route
  access; handlers apply resource checks inconsistently.
- `GITHUB_USER_OR_SERVICE_ROUTE` and similar policies often admit all signed services despite their
  names.
- Session `owner/member` roles do not define owner-exclusive actions and do not govern most access.
- Session creator, provider-account creator, automation creator, and updater fields can be mistaken
  for authorization ownership despite current attribution-only behavior.
- The repository catalog reflects installation authority rather than authenticated-user grants.
- A repository can belong to multiple environments, and environments can contain multiple
  repositories; current data has no rules for combining access at those boundaries.
- Bots differ in external authorization evidence. GitHub has repository permission checks in trigger
  flows, while Slack and Linear rely primarily on webhook authenticity, configured mappings, and
  deployment catalogs.
- Service credentials provide broad route-family capabilities and are not generally constrained by
  actor, creator, repository, or session.
- The web exposes navigation and controls before knowing whether an action could be forbidden.
- There is no complete durable record of allow/deny decisions, policy changes, role assignment, or
  access revocation.
- Existing tests primarily distinguish authenticated from unauthenticated requests, not multiple
  human capability levels or cross-user denial.
- Long-lived sessions, WebSockets, bot mappings, and sandboxes can outlast changes to human access;
  current code has no access-revocation lifecycle because access grants do not exist.
- External operator authority is outside the application and cannot be represented by current
  principals.

## Open Questions

1. Does one Open-Inspect installation correspond permanently to one workspace, or can an
   installation contain multiple independently administered organizations?
2. Are application roles intended to be fixed built-in roles, configurable custom roles, or both?
3. Which role bootstraps the first deployment administrator, and how is loss of all administrators
   recovered?
4. Are repository permissions inherited solely from an application role, assigned per user/group,
   synchronized from SCM, or combined from those sources?
5. Are environments independent authorization resources or derived from access to all, any, or the
   primary member repository?
6. Are sessions private to creators by default, visible to users with target access, or visible to
   the whole workspace?
7. Which session actions differ among creator, participant owner, participant member, repository
   maintainer, and workspace administrator?
8. Does adding a participant grant access, or merely record collaboration after another policy has
   admitted access?
9. Do automation runs and child sessions inherit access from the automation owner, triggering actor,
   target resource, parent session, or a service identity?
10. Which first-party services may read or mutate installation settings, secrets, provider accounts,
    and arbitrary sessions?
11. Do bots act with service-owned capabilities, the asserted human actor's capabilities, or an
    intersection of both under the intended product semantics?
12. How are actors without a linked canonical user handled when authorization requires user-level
    grants?
13. Is viewing secret key metadata distinct from writing or deleting secret values?
14. Are analytics, user directories, audit records, and usage/cost data separate administrative
    capabilities?
15. Which role and grant changes must revoke active WebSockets, bot thread mappings, sandbox access,
    or in-flight provider authorization transactions?
16. Which authorization changes require historical audit retention, and for how long?
17. Must existing admitted users preserve their current broad access when role records first appear?
18. Are deployment operators expected to be application administrators, or are these intentionally
    separate authority domains?

## Evidence

- `packages/control-plane/src/auth/principal.ts`: defines user, service, and sandbox principals and
  service actor-namespace rights.
- `packages/control-plane/src/auth/authenticate.ts`: composes signed web-service and browser-session
  authentication.
- `packages/control-plane/src/auth/identity-enforcement.ts`: derives actor identity and rejects
  caller-supplied identity fields.
- `packages/control-plane/src/auth/user/admission-policy.ts`: defines sign-in admission rules.
- `packages/control-plane/src/db/user-store.ts`: canonicalizes provider identities into users.
- `packages/control-plane/src/routes/shared.ts`: defines route authentication and SCM policies.
- `packages/control-plane/src/router.ts`: attaches principals and enforces principal-kind policies.
- `packages/control-plane/src/db/session-index.ts`: implements installation-wide session visibility.
- `packages/control-plane/src/routes/session-index.ts`: lists and deletes sessions and stores
  per-user read state.
- `packages/control-plane/src/routes/session-runtime-proxy.ts`: exposes session runtime actions.
- `packages/control-plane/src/routes/session-ws-token.ts`: mints participant WebSocket credentials.
- `packages/control-plane/src/routes/session-prompt.ts`: derives prompt authors and allows automatic
  session participation.
- `packages/control-plane/src/session/schema.ts`: stores Session Durable Object participants and
  runtime state.
- `packages/control-plane/src/session/http/handlers/session-lifecycle.handler.ts`: checks
  participation for selected lifecycle mutations.
- `packages/shared/src/types/sessions.ts`: defines `owner/member` participant roles.
- `packages/web/src/lib/browser-auth-session-contract.ts`: exposes browser user identity without
  authorization data.
- `packages/web/src/components/app-auth-boundary.tsx`: gates the application on authentication.
- `packages/web/src/components/session-sidebar.tsx`: exposes shared navigation and All/Mine filters.
- `packages/web/src/components/settings/settings-nav.tsx`: exposes installation settings without
  user-role filtering.
- `packages/control-plane/src/routes/repos.ts`: lists repositories using deployment SCM authority.
- `packages/control-plane/src/routes/environments.ts`: exposes installation-wide environment CRUD.
- `packages/control-plane/src/routes/secrets.ts`: exposes global and repository secret management.
- `packages/control-plane/src/routes/environment-secrets.ts`: exposes environment secret management.
- `packages/control-plane/src/routes/integration-settings.ts`: manages global, repository, and
  environment settings.
- `packages/control-plane/src/routes/model-provider-accounts.ts`: manages installation-wide provider
  accounts with human-only authentication.
- `packages/control-plane/src/routes/automations.ts`: exposes shared automation lifecycle actions.
- `packages/control-plane/src/routes/skills.ts`: separates shared skill administration from per-user
  profiles.
- `packages/control-plane/src/routes/mcp-servers.ts`: exposes shared MCP server management.
- `packages/control-plane/src/routes/analytics.ts`: exposes installation-wide analytics.
- `terraform/d1/migrations/0019_create_users.sql`: creates canonical users and attribution columns.
- `terraform/d1/migrations/0033_environments.sql`: creates environments without ownership or grants.
- `terraform/d1/migrations/0055_session_read_states.sql`: creates per-user session read state.
- `docs/HOW_IT_WORKS.md`: documents the single-tenant security and repository-access model.
- `provider-accounts.md`: explicitly treats creator/updater fields as audit metadata and provider
  accounts as installation-wide.
- `packages/slack-bot/src/sessions/control-plane-client.ts`: sends signed Slack actor session calls.
- `packages/github-bot/src/handlers.ts`: applies GitHub trigger and sender authorization checks.
- `packages/linear-bot/src/webhook-handler.ts`: resolves Linear actors and session targets.
- `packages/control-plane/src/sandbox/client.ts`: authenticates deployment-wide control-plane calls
  to Modal.
- `packages/control-plane/src/router.policy.test.ts`: checks route authentication policy coverage.
- `packages/control-plane/test/integration/ws-token-participants.test.ts`: verifies automatic member
  creation.
