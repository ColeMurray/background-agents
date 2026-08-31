# Open-Inspect MCP and CLI

## Status

Full V1 product requirements, reconciled with the workspace RBAC implementation merged on
2026-08-31. Increment 1 is implemented: device login, revocable CLI credentials, repository-less
text sessions, list/get/prompt/stop/event/wait operations, non-interactive CLI output, and a local
stdio MCP server. Later increments in this document remain proposed.

The public command name in examples is `oi`. The final binary and package names remain a release
decision and do not change the requirements.

## Summary

Open-Inspect will let individual developers and their AI agents launch and manage coding sessions
without using the web interface. V1 provides two automation-oriented surfaces with the same
request/response operations:

- A non-interactive CLI with human-readable, JSON, and streaming NDJSON output.
- A local stdio MCP server distributed with the CLI and authenticated through the same CLI login.

Both surfaces use a shared, server-authorized control-plane contract. The primary workflow is:

1. A developer authenticates the CLI through the existing Open-Inspect web identity flow.
2. The developer configures their AI client to launch the local Open-Inspect MCP server.
3. The AI discovers repositories, environments, models, reasoning options, and skills.
4. The AI creates an Open-Inspect session with an initial prompt and optional attachments.
5. The AI reads historical events, follows incremental progress, waits for the session to settle,
   and sends follow-up prompts when needed.
6. The AI reads resulting diffs, artifacts, pull requests, and child-session state.

Session creation is asynchronous and returns a session ID after initialization and optional initial
prompt preparation, without waiting for agent execution. Separate operations expose history, live
progress, follow-up prompting, stopping, and settlement waits. V1 does not expose raw secrets,
administrative settings, automation CRUD, skill CRUD, session deletion, or child-session creation.

A hosted remote MCP server is a fast-follow product surface. V1 does not depend on it; the local MCP
server establishes the tool contract and validates demand while reusing CLI authentication.

## Decisions

| Area                | V1 decision                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Primary user        | Individual developers and AI agents acting on their behalf.                                                       |
| Primary job         | Launch, observe, and continue Open-Inspect sessions programmatically.                                             |
| Scope               | Sessions plus read-only discovery and session-related output resources.                                           |
| CLI mode            | Non-interactive and automation-oriented; no interactive chat UI.                                                  |
| MCP deployment      | Local stdio server bundled with the CLI.                                                                          |
| Hosted MCP          | Fast follow, not required for V1.                                                                                 |
| Capability model    | CLI and MCP expose the same request/response operations; CLI uniquely adds continuous terminal streaming.         |
| Authentication      | Browser login locally; URL and one-time code for headless systems.                                                |
| Credential lifetime | Revocable 30-day CLI login, invalidated when user access is removed.                                              |
| API keys            | Personal API keys are not required for V1.                                                                        |
| Service accounts    | Deferred unless required for initial operations or deployment.                                                    |
| Authorization       | Enforced by the control plane through the merged workspace RBAC registry and workspace-wide session permissions.  |
| Session creation    | Asynchronous, with optional initial prompt and attachments.                                                       |
| Session target      | Match current product modes: repository set, saved environment, or no repository.                                 |
| Events              | Persisted session events are the historical source of truth; live output follows the same event model.            |
| Waiting             | Explicit wait operation reports when a session settles.                                                           |
| Output              | Human-readable text, JSON, and NDJSON event streams.                                                              |
| MCP tools           | Narrow, composable tools rather than one broad management tool.                                                   |
| Secrets             | Never readable; no new raw-secret input through CLI or MCP.                                                       |
| Related resources   | Repositories, environments, models, reasoning options, and skills are read-only discovery surfaces.               |
| Session outputs     | Artifacts, diffs, pull requests, and child sessions are read-only, except follow-up prompts to an existing child. |
| Webhooks            | Not required; polling and live streams cover V1.                                                                  |

## Motivation

Open-Inspect currently provides session creation and interaction through its web application and bot
integrations. The control plane already has HTTP routes, a session WebSocket protocol, persisted
events, canonical identities, repository/environment discovery, and session-related output APIs.
These interfaces are not available through a general external login or a first-party management CLI.

Customers want their existing AI agents to delegate coding work into Open-Inspect. The initiating
agent needs to create a session, observe its trajectory, wait for it to settle, inspect the result,
and send follow-up instructions. Requiring a person to translate each action through the web UI
breaks that delegation loop.

The researched products validate this workflow through combinations of session APIs, local CLIs,
hosted MCP servers, event streams, and agent/run wait operations. Devin exposes direct session
management through hosted MCP. Cursor separates durable agents from executions and exposes a
resumable run stream. Ona exposes broad environment and agent controls through its CLI and Connect
API. Open-Inspect already has most of the underlying session behavior; the missing product boundary
is external authentication and a stable automation-oriented interface.

## Users

### Individual developer

The developer owns an Open-Inspect identity and has already been admitted to an installation. They
want to use the CLI directly or grant their local AI client the ability to act as them.

### User-operated AI agent

The agent runs in a desktop application, terminal harness, editor, or remote development system. It
connects to the local MCP server, uses the developer's authenticated identity, and delegates one or
more coding tasks to Open-Inspect.

### Platform automation

CI systems and unattended organizational services are likely future users. V1 does not optimize for
them because browser/device login represents a human user and service-account requirements are not
yet critical.

## Jobs To Be Done

- When my AI agent identifies work suited to a background coding agent, I want it to launch an
  Open-Inspect session so work can proceed independently.
- When an Open-Inspect session is running, I want my AI agent to see incremental progress and know
  when work has settled so it can decide whether to continue, inspect, or report back.
- When a session needs clarification or additional work, I want my AI agent to send a follow-up
  prompt into the existing context.
- When work completes, I want my AI agent to inspect the trajectory, diff, artifacts, pull requests,
  and child-session state so it can evaluate the result.
- When choosing a target, model, or skill profile, I want my AI agent to discover valid current
  options instead of relying on hard-coded identifiers.
- When I use the CLI on a remote machine, I want to authenticate from another browser-capable device
  without transferring a web cookie or long-lived raw API key manually.

## Goals

- Let an admitted user authenticate a CLI through the existing web identity system.
- Support browser-capable and browserless/headless machines.
- Let the user's AI client invoke Open-Inspect through a local MCP server.
- Provide equivalent session capabilities in the CLI and MCP server where the protocols permit.
- Create sessions against repositories, multi-repository targets, saved environments, or no
  repository.
- Configure title, model, reasoning effort, skill selection, provider-account selection, initial
  prompt, and attachments during launch where the current product supports them.
- List and inspect sessions.
- Send prompts and attachments to an existing session.
- Read paginated historical trajectories from persisted events.
- Display incremental live progress and provide an explicit wait-until-settled operation.
- Stop active session execution.
- Discover selectable repositories, environments, models, reasoning options, and managed skills.
- Read artifacts, diffs, pull-request state, and child-session state.
- Preserve server-side authorization, auditability, known-secret redaction, immediate policy changes
  for HTTP requests, and a five-minute maximum revocation bound for active streams and waits.

## Non-Goals

- Interactive terminal chat or a terminal recreation of the web session UI.
- Replacing the Open-Inspect web application.
- Personal API-key creation and management.
- General service-account or workload-identity support.
- Hosted remote MCP availability in V1.
- Automation create, update, delete, pause, resume, or trigger operations.
- Skill create, update, delete, assignment, profile, or revision management.
- Repository or environment creation and mutation.
- Secret listing, reading, creation, mutation, or raw secret injection.
- Session archive, unarchive, or delete.
- Explicit child-session creation or cancellation.
- Pull-request creation or mutation from the external interface.
- Artifact upload from the external interface.
- Outbound completion webhooks.
- Replay of transport-specific socket frames; persisted event revisions are recovered through the
  forward checkpoint feed instead.
- A new client-side authorization model.
- Multi-tenant authorization beyond the installation's current and emerging RBAC model.

## Product Principles

### Agent-first, human-operable

Every core operation must be deterministic and usable without prompts, menus, or terminal control
sequences. Human-readable output remains available, but structured output is a first-class contract.

### One capability model

CLI commands and MCP tools map to the same product operations and server-side authorization checks.
Protocol-specific conveniences may differ, but a user must not need one surface to complete a core
session workflow started through the other.

### Async by default

Creating or prompting a session acknowledges accepted work quickly. Observation and waiting are
separate operations. This avoids holding a creation request open for the lifetime of an agent task
and permits many delegated sessions to run concurrently.

### Persisted state over transient state

Historical event reads and canonical session snapshots are authoritative. Live streams reduce
latency but do not become a second source of truth.

### Server-authorized

The CLI and MCP server do not infer access from local state. Every request is authenticated and
authorized by the control plane. The local MCP process is not a security boundary.

### Secrets stay opaque

Discovery can expose that a selectable configuration exists, but neither CLI nor MCP returns secret
values. V1 requires an explicit external-output projection that removes credential fields and
redacts known Open-Inspect-managed secret values from structured events and errors. Diffs and
artifacts are user/session-authored content already visible through the product; V1 does not claim
to detect arbitrary secrets embedded in that content or in unstructured third-party tool output.

## V1 Scope

### Capability Matrix

| Capability                    | CLI | Local MCP                | Notes                                                    |
| ----------------------------- | --- | ------------------------ | -------------------------------------------------------- |
| Login/logout/status           | Yes | Uses CLI credential      | Login remains a CLI operation.                           |
| List repositories             | Yes | Yes                      | Read-only selectable targets.                            |
| List/get environments         | Yes | Yes                      | Read-only selectable targets.                            |
| List models/reasoning options | Yes | Yes                      | Current supported values.                                |
| List managed skills/profiles  | Yes | Yes                      | Read-only session selections.                            |
| List provider accounts        | Yes | Yes                      | Installation metadata gated by `provider_accounts.read`. |
| Create session                | Yes | Yes                      | Optional initial prompt and attachments.                 |
| List sessions                 | Yes | Yes                      | Bounded pagination.                                      |
| Get session                   | Yes | Yes                      | Canonical snapshot and related links.                    |
| Send prompt                   | Yes | Yes                      | Supports attachments.                                    |
| Stop execution                | Yes | Yes                      | Does not delete or archive.                              |
| List historical events        | Yes | Yes                      | Paginated persisted trajectory.                          |
| Follow live events            | Yes | No streaming tool result | MCP uses event pages and wait calls.                     |
| Wait for settlement           | Yes | Yes                      | Returns canonical terminal session state.                |
| List messages                 | Yes | Yes                      | Higher-level conversation view.                          |
| Read artifacts                | Yes | Yes                      | List metadata and retrieve supported content.            |
| Read diffs                    | Yes | Yes                      | Session/repository-aware.                                |
| Read pull requests            | Yes | Yes                      | No create/update operation.                              |
| List/get child sessions       | Yes | Yes                      | No spawn operation.                                      |
| Prompt existing child         | Yes | Yes                      | Uses child-specific server behavior where required.      |
| Automation CRUD               | No  | No                       | Deferred.                                                |
| Skill CRUD                    | No  | No                       | Deferred.                                                |

### Surface Boundary

V1's supported products are the CLI and local MCP server. They communicate with a versioned external
control-plane contract. Direct use of the underlying HTTP contract by third-party applications is
not a separately supported V1 product surface, although requests and responses remain structured and
versioned so the first-party clients can evolve safely.

## Authentication Experience

### Login Command

`oi login` starts one device authorization flow that works on local and remote machines.

On a browser-capable machine:

1. The CLI requests a short-lived login attempt and receives a high-entropy device secret plus a
   separate human-readable user code.
2. The CLI opens the verification URL in the default browser.
3. The user completes the existing GitHub or Google web authentication flow.
4. The browser shows the requesting device and asks the user to approve CLI access.
5. The CLI receives a revocable credential associated with the canonical user and installation.
6. The CLI displays the authenticated user and credential expiration date.

On a headless machine:

1. `oi login --no-browser` prints the verification URL and human-readable user code while retaining
   the high-entropy device secret locally.
2. The user opens the URL on another device and enters or confirms the code.
3. The user completes the same web login and approval flow.
4. The waiting CLI receives the credential without the user copying a bearer token back to the
   remote machine.

If automatic browser opening fails, normal `oi login` displays the same URL and code rather than
failing the flow.

### Login Requirements

- The one-time code expires after 10 minutes, is single-use, and is safe to display in terminal
  output because possession still requires approval through an authenticated browser.
- The CLI polls with a separate unguessable device secret that is never shown in the browser or
  terminal. The control plane stores only its hash.
- Approval atomically binds the authenticated user, installation, user code, and device-secret hash.
  Exactly one polling client can exchange an approved attempt for a credential; later exchanges
  fail.
- The approval page must identify the Open-Inspect installation and requesting CLI device.
- The CLI must not store or reuse the browser's Better Auth cookie.
- The resulting CLI credential represents the canonical authenticated user.
- The user-facing login lasts no more than 30 days and displays its expiration.
- The credential may use shorter-lived access tokens internally, provided refresh is automatic and
  bounded by the 30-day login.
- Every authenticated external request must check the RBAC `users.suspended_at`, role assignment,
  and required permission. Suspending the user or changing their role takes effect on the next HTTP
  request without waiting for local credential expiration.
- Explicit server-side revocation must invalidate the credential.
- V1 event follow and wait behavior uses bounded HTTP polling, so every poll reauthorizes current
  role and suspension state. A later socket-based external stream must use the merged five-minute
  wall-clock authorization lease and reconnect after expiry.
- `oi logout` must revoke the current credential when the server is reachable and always remove the
  local copy.
- `oi auth status` must report installation, user identity, expiration, and whether reauthentication
  is required without printing credential material.
- Re-running `oi login` must replace the active credential for that installation only after the new
  login succeeds.
- A login attempt must never authorize a different installation than the one displayed to the user.

### Credential Storage

The CLI stores credentials in the operating system credential store when available. A file fallback
must use user-only filesystem permissions and clearly report its location. Structured command
output, logs, diagnostics, crash reports, and MCP errors must never include credential values.

### Multiple Installations

The credential model must identify the Open-Inspect installation/base URL. V1 may use one active
context at a time, but login data must not silently cross installations. Commands must provide a way
to inspect and select the active context if more than one login is retained.

### Service Accounts and API Keys

V1 does not require personal API keys or service accounts. The external authentication boundary must
leave room for service-account credentials later without treating a human device credential as a
service identity.

## Authorization and RBAC

The workspace RBAC implementation merged on 2026-08-31 is the authorization source for V1. CLI/MCP
does not add a parallel external-client permission or per-credential scopes. It uses the same
code-owned permission registry, suspension state, route policy metadata, deny-by-default behavior,
and user authorization service as web requests.

- Every external request resolves to the canonical human principal represented by the CLI
  credential.
- CLI credentials authenticate directly as `principal.kind: "user"`; they are not a first-party
  service and do not use bot/service capability ceilings. The explicit external V1 route allowlist
  is the product capability ceiling.
- Authentication never implies authorization.
- The local CLI, local MCP server, and AI client are not trusted to filter unauthorized data.
- Missing role assignments, suspended users, unknown permissions, policy errors, and authorization
  service failures deny access.
- Sessions are workspace resources. Creator and participant fields are attribution and filters, not
  authorization boundaries.
- HTTP requests load current policy on every request. Existing session WebSockets close when their
  non-renewed five-minute authorization lease expires; mutating socket commands recheck their
  required permission when invoked.
- CLI credentials add no permission beyond the user's current role.
- The approval page states that the connected AI client can exercise the user's current role,
  including session mutations that role permits.

### Operation Permissions

| CLI/MCP operation                                    | Required merged RBAC permission(s)                                |
| ---------------------------------------------------- | ----------------------------------------------------------------- |
| Repository list                                      | `repositories.read`                                               |
| Environment list/get                                 | `environments.read`                                               |
| Create with repository target                        | `sessions.create` and `repositories.use`                          |
| Create with environment target                       | `sessions.create` and `environments.use`                          |
| Create without a target                              | `sessions.create`                                                 |
| Create with initial prompt/attachments               | Creation permissions above plus `sessions.collaborate`            |
| Create with managed skills                           | `skills.read`, unless selection is explicitly `none`              |
| Create with an existing profile                      | `skills.read`, `skill_profiles.manage_own`, and profile ownership |
| Skills discovery                                     | `skills.read`; profiles require `skill_profiles.manage_own`       |
| Provider-account discovery/explicit selection        | `provider_accounts.read`                                          |
| Session list/get/events/messages/artifacts/diffs/PRs | `sessions.read`                                                   |
| Prompt or attach to session                          | `sessions.collaborate`                                            |
| Stop session                                         | `sessions.lifecycle`                                              |
| List/read child                                      | `sessions.read` plus direct parent/child validation               |
| Prompt existing child                                | `sessions.collaborate` plus direct parent/child validation        |

Model and reasoning discovery requires an active assigned user and returns only models enabled by
workspace policy. It does not grant `models.preferences.manage`.

The external create adapter performs provider-account and skill/profile checks before account or
skill resolution and before session initialization. The current internal create route does not
enforce these selection-specific grants and is not sufficient by itself.

The default roles consequently behave as follows:

- Owner and Administrator can read and operate every session.
- Member can create, read, collaborate with, stop, sandbox-access, and delete every session.
- Viewer can read every session but cannot create, prompt, attach, stop, or access its sandbox.
- Custom roles receive only their registered permissions.

The external surface exposes only the narrower V1 operation set even when a role has additional web
permissions such as session delete or archive. Route authorization remains workspace-wide exactly as
documented in `docs/AUTH.md`.

## Session Experience

### Discover Targets and Options

Before session creation, a client can discover:

- repositories available to the installation and user;
- saved environments and their ordered repository members;
- supported models;
- valid reasoning-effort values for a selected model where available;
- managed skills and user-selectable skill profiles;
- provider accounts permitted by `provider_accounts.read`, as non-secret ID, provider, status,
  default, and display metadata.

Discovery returns stable identifiers and display metadata. Provider accounts are installation-shared
configuration in the proposed RBAC model, not user-owned resources. Callers with
`provider_accounts.read` can discover and explicitly select them; callers without it omit explicit
selection and use server-resolved defaults. Discovery never returns account tokens or API keys. No
discovery operation returns source-control credentials, repository secrets, environment secrets, or
MCP credentials.

### Create Session

Session creation supports the current mutually exclusive target modes:

- no repository;
- one repository with an optional branch;
- an ordered ad-hoc repository list, where the first repository is primary;
- one saved environment, whose repositories are snapshotted by the existing product behavior.

The request can configure:

- title;
- model;
- reasoning effort;
- managed skill selection;
- model-provider account selections supported by the current session contract;
- initial prompt text;
- initial prompt attachments.

The request does not add a raw secret field or an automatic pull-request behavior field. Pull
requests remain an output of agent work and the existing in-session agent tool.

External create requests reject unknown, disabled, or unauthorized model, reasoning-effort, skill,
profile, provider-account, repository, and environment selections. They never silently replace an
invalid explicit selection with a default. Omitted selections may continue to use documented
server-side defaults.

Managed-skill selection is permission-aware. Explicit `none` requires no skill read grant. Explicit
`all`, an omitted selection that defaults to all, or an existing profile requires `skills.read`;
profile use also requires `skill_profiles.manage_own` and ownership of that profile. A caller
lacking those grants receives a permission error rather than silently receiving or dropping managed
skills.

Before any side effect, composite creation authorizes every requested stage. A request with an
initial prompt or attachment requires both the applicable creation/target permissions and
`sessions.collaborate`; a role with `sessions.create` but no collaborate permission can create only
an unprompted session. Resuming an idempotent partial operation reauthorizes current user
suspension, role permissions, target use, and workspace session permission before upload or prompt
delivery continues.

The operation returns after the session is initialized and the initial prompt, when supplied, is
accepted for delivery. It does not wait for sandbox startup or task completion. The response
includes at least:

```json
{
  "sessionId": "session-id",
  "status": "created",
  "url": "https://open-inspect.example/sessions/session-id"
}
```

Every create operation carries a client-generated idempotency key. Repeating a request with the same
key and equivalent input returns the original session result rather than creating another session;
reusing the key with different input returns a conflict.

Initial attachments require the session ID before they can be uploaded. The product operation
therefore creates the session, uploads every attachment to that session, and only then enqueues the
initial prompt. If any upload or prompt delivery fails, the response identifies the created session,
reports the failed stage, and does not enqueue a prompt with a partial attachment set. Retrying with
the same idempotency key resumes or returns the same operation rather than creating another session.
Images uploaded before a later-stage failure remain bound to the created session and follow normal
session attachment retention; they cannot be referenced from another session.

### List Sessions

Session listing uses the current limit/offset pagination, with a maximum page size of 100, and
defaults to newest activity first. Each item includes the fields needed to select a session without
loading its full trajectory:

- session ID and title;
- canonical session status;
- repository/environment summary;
- creator identity permitted by current visibility rules;
- creation and last-update timestamps;
- archive state where existing records include it;
- web URL;
- parent session ID when the session is a child.

V1 filtering covers the existing status, excluded-status, automation-lineage, and creator filters.
Repository and environment filters are deferred until the session index supports them directly.
Unsupported filters fail explicitly rather than being silently ignored.

### Get Session

Session read returns the canonical session snapshot used by the web product, including current
status, target, participant-visible metadata, active sandbox state, and links or identifiers for
related messages, events, artifacts, diffs, pull requests, and children. It does not embed the full
trajectory by default.

### Send Prompt

A caller can enqueue a follow-up with text, attachments, or both. Blank text without attachments is
invalid. The operation returns acknowledgement and message identity without waiting for completion.
Prompt ordering follows the existing session queue behavior.

Every prompt operation carries a client-generated idempotency key scoped to the canonical user and
session. Repeating equivalent input with the same key returns the original message acknowledgement;
reusing the key with different prompt, attachment, model, or reasoning input returns a conflict. The
idempotency record is retained with the session/message history so a network retry cannot enqueue
duplicate work.

The caller can select model and reasoning overrides only where the existing prompt contract permits
them. Callback context and integration-owned identity fields are not accepted from CLI/MCP users. An
explicit invalid or disabled model/reasoning combination returns a validation error rather than
being ignored or replaced with a default.

### Stop Session

A caller can stop active execution through the current stop semantics. Stop does not archive,
delete, or erase the session. The resulting status remains observable through session reads and
events.

### Child Sessions

V1 can list child sessions, inspect one child, read its trajectory, and send a follow-up where the
existing child lifecycle accepts follow-ups. V1 does not expose child creation, explicit model/depth
controls for spawning, or child cancellation.

The current child-follow-up route is sandbox-authenticated and derives attribution from parent agent
activity. External child prompting therefore requires a new user-authenticated operation that
authorizes the canonical user against the parent/child session tree and records that user as the
source of the follow-up.

This is an intentional V1 mutation exception: explicit child spawning remains agent-internal, but a
user or user-operated agent may continue an already visible child by addressing that child session.

The interface must distinguish control-plane child sessions from OpenCode internal subtask activity
that appears inside a single session trajectory.

## Events and Trajectories

### Historical Source of Truth

Persisted session events are the authoritative trajectory. Existing event rows can be updated in
place as text and tool state evolve, so an event ID alone is not an immutable delivery identity. V1
therefore exposes two related views:

- A canonical history snapshot containing the latest persisted revision of each event in timeline
  order.
- A forward change feed containing every externally visible event creation or revision after an
  opaque checkpoint.

Each event has a stable event ID and a monotonically increasing revision. Each change has a
session-monotonic checkpoint. The snapshot response includes a high-water checkpoint representing
all changes included by that snapshot. Event IDs, revisions, and checkpoints are opaque except for
comparison of revisions belonging to the same event ID.

The external envelope is a deliberate projection of the current internal event contract:

```json
{
  "id": "event-id",
  "revision": 2,
  "checkpoint": "opaque-checkpoint",
  "type": "tool_call",
  "messageId": "message-id",
  "createdAt": 1788004800000,
  "updatedAt": 1788004805000,
  "data": {}
}
```

The exact `data` shape depends on event type and follows the shared session event contract. A change
feed request with `afterCheckpoint` returns changes strictly after that checkpoint in forward commit
order. Applying only changes with a revision greater than the client's current revision for that ID
reconstructs current trajectory state without losing tool/text updates. Reusing the same checkpoint
is safe and can replay identical `(id, revision)` pairs.

Canonical event snapshots are retained with normal session history. The forward revision feed is a
rolling recovery window, retained for up to 24 hours and at most 50,000 revisions per session. The
server may coalesce high-frequency internal token/tool updates before creating an external revision,
but it must persist and publish the final revision of each event.

When retention removes a requested checkpoint, the server returns `checkpoint_expired` with no
partial changes. The client fetches a fresh canonical snapshot and continues from its new high-water
checkpoint. The server captures that checkpoint consistently so snapshot-then-follow has no gap.

The existing endpoint returns persisted JSON directly and has no forward update checkpoint, so V1
requires a new external event projection/change feed. That projection removes fields classified as
credentials and redacts exact values of Open-Inspect-managed secrets available to the session. It
does not claim to detect arbitrary credentials copied into unstructured user or third-party tool
text.

### Higher-Level Messages

Clients can also read the persisted message/conversation view used by integrations and the web
application. Messages provide a simpler user/assistant trajectory when a caller does not need every
tool or sandbox event. Event history remains available for complete inspection.

### Live Progress

Increment 1 follows progress by repeatedly polling bounded forward change-feed pages after the
snapshot's high-water checkpoint. Human-readable mode renders concise status and assistant progress.
NDJSON mode emits one complete event revision per line and does not mix progress logs into stdout.
The client applies changes in forward checkpoint order, deduplicates identical `(id, revision)`
pairs, and advances its checkpoint only after consuming every page in the bounded response.

Live broadcast transport and reconnect semantics are deferred. A later live transport must persist
each externally visible revision before broadcast and carry the same event ID, revision, and
checkpoint as the forward change feed. After reconnecting, the client first requests changes after
its last applied checkpoint; a later revision of the same event is emitted and replaces that event
in canonical state.

### Settlement

`session_wait` and the corresponding CLI operation wait until the requested session reaches one of
the current canonical terminal statuses: `completed`, `failed`, `cancelled`, or `archived`.
`created` and `active` are not settled. Sandbox state does not alter settlement because session and
sandbox lifecycles are intentionally separate. Child sessions do not delay parent settlement;
callers that need child completion wait on those child session IDs separately.

The wait result includes the canonical session status, latest assistant message when available, and
identifiers for newly available pull requests or artifacts. A wait timeout is not a session failure;
it returns a distinct timed-out result with current state. V1 does not invent waiting-for-user or
waiting-for-approval states that are absent from the canonical session status contract.

The implementation may combine live events with canonical status polling. The final result must be
confirmed against canonical persisted session state rather than inferred only from a transient
event.

## Attachments

- Initial and follow-up prompts support the image formats currently accepted by the web product:
  PNG, JPEG, WebP, and GIF, up to six images and 10 MiB per image.
- The CLI accepts local file paths and uploads content through authenticated Open-Inspect attachment
  handling before sending the prompt.
- MCP local-path attachments require roots negotiated through the MCP session. The server resolves
  the real path after symlinks and accepts a file only when that final path remains beneath a
  granted root. When the client supplies no roots, local-path attachment input is disabled. Tool
  arguments cannot add or widen roots.
- `session_prompt` may also accept attachment IDs previously uploaded to that same session. V1 does
  not accept arbitrary attachment URLs or attachment IDs from another session.
- Structured errors identify the rejected attachment without exposing local filesystem content.
- Artifact upload is separate from prompt attachments and remains out of scope.

## Session Outputs

### Artifacts

Clients can list the current artifact types: `pr`, `screenshot`, `video`, `preview`, and `branch`.
V1 does not introduce a generic file-artifact abstraction.

- Screenshot and video bytes remain available through the current protected media path.
- PR and branch artifacts return structured metadata only.
- Preview artifacts return their existing authorized URL/metadata representation; V1 does not
  promise arbitrary preview-file downloads.
- Artifact responses preserve artifact ID, type, timestamps, URL when already present, and typed
  metadata available for that artifact kind.

V1 does not upload, modify, or delete artifacts through CLI/MCP. A future generic artifact resource
can add canonical filename, content type, size, and temporary download semantics.

### Diffs

Clients can read the current session diff and file-level diff details supported by the web product.
Multi-repository sessions must retain repository identity in diff responses. V1 does not apply or
edit diffs through this interface.

### Pull Requests

Clients can list and read pull requests associated with the session, including repository, provider,
number, URL, state, head branch, and base branch where available. The current product stores and
summarizes this data but does not expose a general pull-request read route, so V1 requires a new
read-only projection. V1 does not create, refresh, close, merge, or otherwise mutate pull requests
through CLI/MCP.

## CLI Requirements

### Command Shape

The command hierarchy uses nouns and explicit actions. Illustrative V1 commands are:

```text
oi login [--no-browser]
oi logout
oi auth status
oi context list
oi context use <name>

oi repo list
oi environment list
oi environment get <id>
oi model list
oi skill list
oi provider-account list

oi session create [target and execution options]
oi session list
oi session get <session-id>
oi session prompt <session-id> [prompt and attachment options]
oi session stop <session-id>
oi session events <session-id> [--follow]
oi session messages <session-id>
oi session wait <session-id>
oi session artifacts <session-id>
oi session diff <session-id>
oi session prs <session-id>
oi session children <session-id>

oi mcp serve
```

The final command grammar can consolidate read-only subresources, but all capability-matrix
operations must remain directly invocable without an interactive menu.

### Input

- Commands accept flags for simple values and JSON input for complete structured requests.
- Prompt text can be supplied as an argument, stdin, or a file.
- Attachments can be repeated as local path flags.
- Create and prompt commands generate an idempotency key by default and accept an explicit
  `--idempotency-key` so callers can safely retry after an unknown outcome.
- Conflicting target modes fail before creating a session.
- Empty or malformed structured input fails with field-level errors.
- Commands do not prompt for missing business inputs in non-interactive mode.
- Authentication may prompt only as part of the explicit login command.

### Output

Every non-authentication command supports:

- `text`: concise human-readable output;
- `json`: one complete JSON result;
- `stream-json`: NDJSON for operations that can emit progress.

`json` and `stream-json` write only machine-readable data to stdout. Diagnostics and progress that
are not part of the schema go to stderr. Successful create/prompt commands expose stable
identifiers. Failures return a non-zero process exit code and a structured error in JSON modes when
possible.

### Exit Behavior

Exit codes distinguish at least:

- success;
- invalid local input;
- unauthenticated or expired login;
- forbidden operation;
- resource not found;
- conflict or session state rejection;
- network/service failure;
- wait timeout;
- remote session failure when a command explicitly waits for completion.

The numeric mapping must be documented and stable for the V1 compatibility period.

## MCP Requirements

### Deployment

The V1 MCP server runs locally over stdio and is launched by an MCP-compatible client.
`oi mcp serve` loads the selected Open-Inspect context and CLI credential, then communicates with
the remote control plane. It must not require the AI client to receive or embed an Open-Inspect
bearer token in MCP configuration.

An illustrative client configuration is:

```json
{
  "mcpServers": {
    "open-inspect": {
      "command": "oi",
      "args": ["mcp", "serve"]
    }
  }
}
```

If no valid CLI login exists, server startup or the first tool call returns an actionable error that
directs the user to `oi login`. The MCP server must not start an interactive browser flow inside an
arbitrary AI tool call.

### Tool Design

V1 uses narrow tools with explicit verbs and resource scopes:

| Tool                    | Purpose                                                                  |
| ----------------------- | ------------------------------------------------------------------------ |
| `repository_list`       | Discover selectable repositories.                                        |
| `environment_list`      | Discover saved environments.                                             |
| `environment_get`       | Read one environment and its ordered repositories.                       |
| `model_list`            | Discover models and reasoning options.                                   |
| `skill_list`            | Discover selectable managed skills/profiles.                             |
| `provider_account_list` | Discover permitted installation provider-account metadata.               |
| `session_create`        | Idempotently create a session and optionally enqueue its initial prompt. |
| `session_list`          | List visible sessions with pagination and filters.                       |
| `session_get`           | Read canonical session state.                                            |
| `session_prompt`        | Idempotently enqueue a follow-up prompt or attachments.                  |
| `session_stop`          | Stop active execution.                                                   |
| `session_events`        | Read a canonical snapshot page or forward revisions after a checkpoint.  |
| `session_messages`      | Read the higher-level conversation.                                      |
| `session_wait`          | Wait for settlement or timeout.                                          |
| `session_artifacts`     | List/read session artifacts.                                             |
| `session_diff`          | Read session and file diffs.                                             |
| `session_pull_requests` | Read associated pull requests.                                           |
| `session_children`      | List/read child-session state.                                           |
| `session_child_prompt`  | Send a follow-up to an existing child session.                           |

Tool descriptions must tell an agent when to create a new session, when to send a follow-up, and
when to use wait versus event pagination. They must not imply access to secrets or unsupported
mutation.

### MCP Behavior

- Tool inputs and outputs use JSON Schema and stable resource identifiers.
- `session_create` and `session_prompt` require caller-supplied idempotency keys so an MCP client
  can reuse the same key after an unknown result.
- Long-running work is represented by `session_wait`, not by holding `session_create` open.
- `session_wait` accepts a caller-controlled timeout and returns current state when it expires.
- Event history uses pagination; one tool response must not attempt to return an unbounded
  trajectory.
- Artifact tools return bounded metadata and protected media URLs; diff content uses bounded pages
  with explicit truncation and continuation.
- Tool errors distinguish authentication, authorization, validation, not found, conflict, timeout,
  and service failure.
- MCP tool calls are attributed to the authenticated canonical user.
- The local server may expose read-only MCP resources later, but tools are sufficient for V1.

### V1 Limits

| Resource                                            | Default        | Maximum and continuation                                                 |
| --------------------------------------------------- | -------------- | ------------------------------------------------------------------------ |
| Session/repository/environment/skill/provider lists | 50 items       | 100 items; use limit/offset continuation                                 |
| Event snapshot/change page                          | 100 revisions  | 500 revisions; use page cursor or forward checkpoint                     |
| Message page                                        | 50 messages    | 100 messages; use continuation cursor                                    |
| `session_wait`                                      | 60 seconds     | 300 seconds per call; callers may repeat using current session state     |
| Diff file list                                      | 50 files       | 100 files per page                                                       |
| Diff content                                        | 256 KiB        | 512 KiB per response; return `truncated: true` and a continuation cursor |
| Serialized MCP tool result                          | Not applicable | 1 MiB; larger results must paginate or return protected media URLs       |

Every truncated response includes `hasMore` and a continuation cursor/checkpoint. A server never
silently drops content to satisfy a limit. Attachment limits are defined separately by the existing
six-image, 10 MiB-per-image contract.

### Hosted MCP Fast Follow

A hosted service is expected to expose the same product capabilities over MCP Streamable HTTP, but
its final tool schemas, authentication, and attachment behavior are not V1 requirements. V1 avoids
unnecessary local-only assumptions in shared session semantics without freezing the hosted contract.

## External Control-Plane Contract

The first-party CLI and MCP server require a versioned server contract that covers authentication,
discovery, sessions, prompts, events, and read-only outputs. The contract may adapt existing
internal routes, but external callers must not be required to produce internal service signatures or
forward browser cookies.

External routes are a new SCM-neutral route family, not aliases of current GitHub-only route
metadata. Repository-less operations work independently of SCM. Repository/environment operations
support GitHub and GitLab through the configured provider and shared repository identity helpers;
Bitbucket remains unsupported until the product implements it.

### Contract Requirements

- External routes are explicitly versioned.
- Authentication uses the issued CLI credential or its short-lived derivative.
- Request identity comes from the verified principal, never caller-supplied user fields.
- Existing internal callback context, service-only fields, sandbox credentials, and SCM credential
  brokerage remain unavailable.
- Canonical event history uses an opaque page cursor; forward event polling and live recovery use
  the external revision checkpoint. Session listing retains bounded limit/offset pagination in V1.
- Session creation and prompt submission require idempotency keys. Stop remains idempotent under its
  current lifecycle semantics. Mutation responses distinguish accepted, rejected, and unknown
  outcomes so clients do not guess after network failure.
- Create-session response semantics identify partial prompt-delivery failure.
- Errors use one consistent machine-readable envelope with code, message, optional field details,
  and request ID.
- Server responses include enough request correlation for support diagnostics without exposing
  secrets.

### Compatibility

V1 is allowed an explicitly labeled beta period. During beta, schema changes are documented and kept
additive where practical. After the V1 contract is declared stable:

- existing fields and enum values retain their meanings;
- additive response fields do not require a version change;
- clients ignore unknown additive response fields;
- breaking request, response, authentication, or tool-schema changes require a new version or a
  documented deprecation period;
- CLI and local MCP versions report their client version with requests;
- the server returns an actionable incompatibility error for unsupported clients.

## Error Experience

All surfaces use a shared error taxonomy. At minimum:

| Code                  | Meaning                                                     |
| --------------------- | ----------------------------------------------------------- |
| `unauthenticated`     | Login is absent, expired, revoked, or invalid.              |
| `forbidden`           | Identity is valid but lacks server-side permission.         |
| `invalid_request`     | Input failed validation, with field details where possible. |
| `not_found`           | Requested visible resource does not exist.                  |
| `conflict`            | Current session/resource state rejects the operation.       |
| `rate_limited`        | Caller must retry after a server-provided interval.         |
| `attachment_rejected` | Attachment type, count, size, or upload failed.             |
| `stream_interrupted`  | Live observation disconnected before settlement.            |
| `checkpoint_expired`  | Forward event checkpoint left the rolling recovery window.  |
| `wait_timed_out`      | Wait duration elapsed; session remains valid.               |
| `service_unavailable` | Transient Open-Inspect or provider failure.                 |
| `incompatible_client` | CLI/MCP version is unsupported.                             |

Human-readable errors include an action when one is known, such as logging in again, selecting a
different target, retrying a prompt, or inspecting the session by ID. Machine output does not rely
on parsing error prose.

## Security and Privacy

- CLI credentials are bearer-equivalent secrets and must be encrypted by the operating system store
  or protected by user-only file permissions.
- Login approval binds the credential to one installation and canonical user.
- Human user codes and high-entropy device secrets are distinct, single-use, expire after 10
  minutes, and are invalidated after success or cancellation; only a hash of the device secret is
  stored.
- The control plane records credential creation, use metadata, revocation, and last-seen time
  without recording token material.
- Session mutations record the acting canonical user and external client surface.
- High-volume event reads may use aggregate access telemetry rather than one durable audit row per
  event, provided security investigations can identify the principal and request.
- The external-output projection removes credential fields and redacts exact known values from
  Open-Inspect-managed secret stores before returning events or errors. Arbitrary unstructured text
  is not represented as having perfect secret detection.
- External clients cannot call sandbox-only, callback-only, or SCM credential-broker endpoints.
- Local MCP configuration contains only the command/context selector, not a copied credential.
- Attachment paths and local file contents are never included in analytics or errors beyond the
  minimum user-visible filename needed to identify a failure.
- Rate limits apply per credential/principal and protect session creation, prompt submission, event
  reads, and login polling.

## Reliability Requirements

- A successful session-create acknowledgement always includes a usable session ID.
- Retrying session creation with the same idempotency key returns the original session; reusing the
  key with different input returns a conflict.
- Retrying a prompt with the same per-user/session idempotency key returns the original message;
  reusing the key with different input returns a conflict.
- Prompt acknowledgement distinguishes accepted, rejected, and unknown delivery outcomes while
  retaining the key for safe recovery from an unknown network result.
- Event history and forward-change pages have deterministic ordering and no omission across page
  boundaries.
- Live-follow recovery resumes after the last applied checkpoint and deduplicates only identical
  event ID/revision pairs.
- `session_wait` confirms settlement from canonical session state.
- A CLI/MCP process restart does not lose server-side session state or require the session to be
  recreated.
- Login polling tolerates transient network failures until the login attempt expires.
- Logout removes local credentials even when remote revocation cannot be reached and reports the
  incomplete remote revocation.
- One failing session does not terminate event following or waits for unrelated sessions run by the
  same external agent.

## Observability and Audit

The product records or derives:

- login attempts, approvals, expirations, revocations, and failures;
- active CLI/MCP client versions;
- command/tool operation name and outcome;
- canonical user and installation;
- session IDs created or mutated;
- latency and error class for create, prompt, event, and wait operations;
- live-stream connection duration and disconnect reason;
- wait duration and settled outcome;
- attachment upload count, size category, and rejection class without content;
- use of CLI versus local MCP;
- rate-limit events and unsupported-client errors.

Audit data must not include prompts, event bodies, diffs, artifacts, credentials, or secret values
by default.

## Success Measures

V1 is successful when a developer's existing AI client can complete this workflow without the web UI
after initial login:

1. Discover a repository or environment.
2. Launch a session with an initial prompt.
3. Receive the session ID after any initial attachment upload and prompt acceptance, without waiting
   for agent execution.
4. Observe incremental progress or poll persisted events.
5. Wait until the session settles.
6. Inspect the final conversation and diff/PR/artifact state.
7. Send a follow-up prompt and observe the next trajectory.

Product telemetry will measure:

- successful login completion rate by browser-capable versus headless flow;
- users who create at least one session through CLI/MCP after login;
- sessions created through CLI versus MCP;
- successful create-to-first-event rate;
- successful wait-to-settlement rate;
- live-stream disconnect and reconciliation rate;
- follow-up prompt acceptance rate;
- authentication expiration/revocation failures;
- frequency of external agents inspecting outputs after settlement.

Numerical adoption targets are set for the customer beta once the initial cohort and traffic volume
are known. Functional acceptance does not depend on an arbitrary adoption target.

## Implementation Increments

### Increment 1: Core Delegation Loop

The first production increment delivers a complete, repository-less, text-only loop rather than
partially exposing every V1 resource:

- browser/headless device login, logout, status, 30-day revocable CLI credentials;
- direct human-user bearer authentication and current RBAC checks;
- repository-less session create with an initial text prompt and idempotency;
- session list/get, idempotent text follow-up, stop, resumable event-change polling, and bounded
  wait;
- non-interactive text/JSON/NDJSON CLI output;
- local stdio MCP tools for the same operations.

Increment 1 rejects repository/environment targets, attachments, managed-skill/profile selections,
explicit provider accounts, child operations, pull-request reads, and generic output downloads.
Fields are rejected explicitly rather than ignored. Its bounded event change feed provides pinned
snapshots, monotonic checkpoints, coalesced upserts, and delete tombstones. Changes are retained for
up to 24 hours and at most 50,000 revisions per session; an older checkpoint returns
`checkpoint_expired` so the client can resume from a fresh snapshot. Live transport remains later
work. The external route family remains versioned so later increments add capabilities without
changing the core login/session contract.

### Later V1 Increments

Later increments add discovery and targets, attachments with negotiated MCP roots, skill/provider
selection, live event transport, artifacts/diffs/PRs, and child reads/follow-up. Full V1 is complete
only when every acceptance criterion below is met.

## Acceptance Criteria

### Authentication

- A user can run `oi login`, authenticate through the configured GitHub or Google web provider, and
  return to an authenticated CLI.
- A headless user can complete the same login from another device using a one-time code.
- The human-readable user code cannot poll or redeem a credential; only the initiating CLI's
  high-entropy device secret can exchange one approved attempt, exactly once.
- A CLI login expires within 30 days and reports its expiration.
- Suspending the user or removing a required workspace permission affects the next CLI/MCP HTTP poll
  or mutation.
- V1 follow/wait polling stops on the first denied request. A future socket stream reconnects after
  the merged five-minute wall-clock authorization lease expires.
- `oi logout` removes the local credential and attempts server revocation.
- No command, log, JSON result, or MCP response prints issued CLI credentials or structured
  managed-credential fields. User/session-authored content retains the separately documented
  unstructured-content boundary.

### Session Workflow

- CLI and MCP can discover valid repositories, environments, models, reasoning options, and skills
  when the current role permits them. `provider_accounts.read` gates installation provider-account
  discovery and explicit selection.
- CLI and MCP can create repository, multi-repository, environment, and repository-less sessions
  according to current target validation.
- Composite creation verifies create, target-use, and collaborate permissions before creating the
  session or uploading attachments.
- Initial and follow-up prompts accept supported attachments.
- Create returns a session ID before agent completion.
- CLI and MCP can list and read the created session.
- CLI can follow incremental events in text and NDJSON formats.
- CLI and MCP can read the same persisted historical trajectory in deterministic order.
- CLI and MCP can wait for settlement and distinguish timeout from session failure.
- CLI and MCP can send a follow-up and observe subsequent events.
- Retrying create or prompt with the same idempotency key cannot create duplicate sessions or
  messages.
- Explicit invalid model, reasoning, target, skill, profile, or provider-account selections fail
  validation rather than falling back silently.
- CLI and MCP can read associated messages, artifacts, diffs, pull requests, and children.
- Unsupported mutations, including delete, archive, child spawn, PR creation, and secret access, are
  absent rather than merely hidden in documentation.

### Authorization and Safety

- Every operation is authorized by the control plane as the canonical logged-in user.
- Login requires an active RBAC assignment and explicitly discloses that the client inherits the
  user's current role permissions.
- A client cannot assert another user, service, callback context, or sandbox identity.
- A client cannot retrieve secret-store values or credential fields from repository, environment,
  model-provider, MCP, or integration configuration. Known managed secret values are redacted from
  structured external events and errors. Diffs, artifacts, prompts, and arbitrary tool text retain
  the same user-visible content boundary as the web product and are not represented as secret-free.
- Missing role permissions produce `forbidden`; authenticated roles with `sessions.read` can read
  all workspace sessions.
- Member can read, prompt, and stop any workspace session; Viewer can read but cannot create,
  prompt, attach, or stop; Administrator and Owner can operate any session.
- Revoked and expired credentials fail closed.

### Protocol Quality

- Structured CLI output is valid JSON or NDJSON with no mixed stdout diagnostics.
- MCP tool schemas are discoverable and enforce the documented V1 page, response, diff, and wait
  limits.
- MCP path attachments cannot escape negotiated roots, including through symlinks; path attachments
  are unavailable when no roots are granted.
- Error codes are consistent between CLI and MCP.
- Snapshot plus forward-checkpoint reconciliation does not omit event revisions or emit the same
  `(eventId, revision)` twice; later revisions of one event remain observable.
- A checkpoint outside the 24-hour/50,000-revision recovery window returns `checkpoint_expired` and
  a fresh snapshot resumes observation without treating the condition as session failure.
- Client and server versions are observable for compatibility diagnostics.

## Dependencies

- Existing canonical user and Better Auth web login.
- A device authorization and CLI credential lifecycle in the control plane.
- The merged workspace RBAC role assignment, `suspended_at` state, route policies, service ceilings,
  and five-minute WebSocket authorization leases.
- Enforced server-side workspace permissions shared with web principals.
- Existing session create, prompt, stop, snapshot, event, message, diff, artifact metadata, and
  child-session routes.
- New external projections for sanitized events, pull-request reads, and typed artifact metadata not
  already covered by current media routes.
- A forward event revision/checkpoint feed shared by polling and live observation.
- Retry-safe prompt idempotency keyed by canonical user, session, and client request ID.
- A new user-authenticated child-follow-up operation with canonical-user authorization and
  attribution; the current sandbox-authenticated child route is not sufficient.
- Existing repository, environment, model, reasoning, skill, and provider-account discovery data.
- Existing attachment upload and prompt attachment handling.
- Stable shared session and event contracts.
- Packaging and distribution for the CLI and local MCP server.

## Risks and Constraints

### Browser identity does not currently equal external API authentication

The current browser backend signs requests as `service:web` and forwards the browser session. The
CLI cannot safely copy that browser behavior or cookie. V1 requires a distinct revocable credential
that still resolves to the same canonical user.

### Current authorization is broad

Open-Inspect is single-workspace and session permissions are intentionally workspace-wide. CLI
credentials do not add per-credential scopes; they inherit the canonical user's current role. This
means a Member-authorized local AI can read, prompt, stop, sandbox-access, or delete any session in
the web product, although the V1 external surface deliberately omits sandbox access and deletion.

### Event schemas evolve with agent runtimes

The web trajectory contains event-type-specific payloads, including tool details. A stable envelope,
additive parsing, redaction, and version reporting are needed so external agents do not couple to
incidental internal fields.

### MCP tool responses are bounded

Complete trajectories and diffs can exceed practical MCP response limits. Pagination and summaries
prevent one tool call from returning unbounded content; artifact tools return bounded metadata and
existing protected media URLs rather than generic file bytes.

### Local MCP inherits local-user trust

Any local process that can invoke the MCP server through an authorized client can ask it to perform
operations as the logged-in user. The MCP process cannot replace operating-system isolation or the
AI client's own tool-approval controls.

### Session create plus initial prompt spans existing operations

The current session creation and prompt interfaces are separate. The external product operation must
make partial success explicit so retries do not create duplicate sessions or lose the session ID.

## Fast Follow

The expected first fast-follow release exposes comparable product capabilities through a hosted
remote MCP server using MCP Streamable HTTP. It adds remote MCP authentication and authorization
without requiring the local CLI process. Exact tool and attachment contracts are determined in that
release rather than constrained by V1 acceptance.

Other post-V1 candidates are:

- service accounts and scoped machine credentials;
- user-managed personal API keys;
- explicit credential scopes;
- automation CRUD and run inspection;
- managed skill CRUD;
- outbound session webhooks;
- MCP resources for read-only trajectories and artifacts;
- child-session creation and cancellation;
- session archive, unarchive, and delete;
- direct public API and generated SDK support;
- transport-specific hosted stream optimizations beyond the durable event revision feed.

## Open Questions

- Final binary, package, and command name (`oi` is a working name).
- Supported operating systems and installation channels for the first beta.
- Whether one active installation context is sufficient for V1 UI, even if credentials retain
  multiple contexts.
- Beta compatibility window and minimum supported CLI version policy.
- Hosted MCP authentication method and timing after local MCP validation.

## Related Documentation

- `docs/AUTH.md`
- `packages/shared/src/rbac.ts`
- `public/docs/internal/2026-08-29-mcp-external-agent-interfaces-research.md`
- `docs/HOW_IT_WORKS.md`
- `packages/control-plane/README.md`
- `packages/shared/src/types/session-api.ts`
- `packages/control-plane/src/session/event-stream.ts`
- `packages/control-plane/src/routes/session-create.ts`
- `packages/control-plane/src/routes/session-prompt.ts`
- `packages/control-plane/src/routes/session-runtime-proxy.ts`
- `packages/control-plane/src/routes/session-children.ts`
- `packages/control-plane/src/routes/session-child-spawn.ts`
- `packages/control-plane/src/routes/session-ws-token.ts`
- `packages/web/src/lib/control-plane.ts`
- `packages/control-plane/src/auth/authenticate.ts`
