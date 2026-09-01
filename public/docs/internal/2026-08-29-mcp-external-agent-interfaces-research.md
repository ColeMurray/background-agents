# Research: MCP and External Agent Interfaces

**Date:** 2026-08-29 **Updated:** 2026-08-31 **Status:** Research only **Scope:** Publicly
documented CLI, API, MCP, event, and integration interfaces for Devin, Ona, and Cursor Cloud Agents,
compared with the current Open-Inspect system surface.

This document is intentionally research-only. It does not include recommendations, implementation
plans, proposed code/API/schema changes, task breakdowns, estimates, or rollout steps. External
product documentation was explicitly included in the requested scope.

## Summary

The current Open-Inspect repository exposes MCP configuration, a large internal control-plane API,
and an implemented Increment 1 external surface: revocable user CLI credentials, a versioned
repository-less session API, a first-party `oi` CLI, and a local stdio MCP server. Full V1
discovery, targets, attachments, output projections, and hosted MCP remain unimplemented.

The researched products expose different combinations of control surfaces:

| Product            | Public agent API                                                   | Agent-management CLI                                                        | Product as MCP server                           | Product as MCP client                              | Live events                                                                |
| ------------------ | ------------------------------------------------------------------ | --------------------------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------- |
| Devin              | REST v3                                                            | Local-agent CLI; cloud handoff                                              | Yes, hosted Streamable HTTP server              | Yes                                                | REST polling and MCP event tools; no documented public cloud SSE/WebSocket |
| Ona                | Connect/protobuf API                                               | Broad environment and execution CLI                                         | No public Ona management server found           | Yes                                                | Connect server stream via `WatchEvents`                                    |
| Cursor             | REST v1 public beta; legacy v0                                     | Local/headless CLI and private workers; no documented hosted-agent CRUD CLI | No public general management server found       | Yes                                                | Per-run SSE with resume IDs                                                |
| Open-Inspect today | Versioned Increment 1 session API plus internal HTTP/WebSocket API | Local `oi` core session CLI                                                 | Local stdio management server; no hosted server | Yes, configured servers are injected into sessions | Projected checkpoint/change polling; internal session WebSocket            |

Across the three external systems, the common programmatic resource operations are create, list,
get, follow up, observe status, stop or cancel, archive, delete, inspect outputs, and manage related
repository state. Their primary resource models differ:

- Devin centers a session whose messages, status, attachments, tags, and lifecycle are manipulated
  directly.
- Ona centers environments and agent executions. A `sessionId` correlates resources, but no public
  standalone session CRUD service was found.
- Cursor v1 separates a durable agent from per-prompt runs. Conversation and workspace state belong
  to the agent, while execution status and results belong to runs.

MCP exposure also differs. Devin publishes a hosted MCP server that lets third-party MCP clients
manage sessions, knowledge, playbooks, schedules, and integration status. Ona and Cursor publicly
document their products as MCP clients/hosts for tools used by agents; no equivalent public,
general-purpose Ona or Cursor management MCP server was found.

## Research Questions

1. Which CLI, API, MCP, event, and integration surfaces do Devin, Ona, and Cursor expose?
2. What resource and lifecycle models are visible through those interfaces?
3. What are the documented authentication, request, response, pagination, and streaming shapes?
4. Which system-management functions are exposed through MCP rather than only REST or RPC?
5. What comparable interfaces exist in Open-Inspect today?
6. Which interface details are undocumented, inconsistent, deprecated, or version-sensitive?

## Comparative Surface

| Capability                     | Devin                                                                 | Ona                                                                | Cursor Cloud Agents                                                                                |
| ------------------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Create work                    | `POST /v3/organizations/{org_id}/sessions`                            | `StartAgent` or `CreateEnvironment` Connect RPC                    | `POST /v1/agents` creates agent and initial run                                                    |
| List/read work                 | Session list/get/messages/attachments                                 | List/get environments and agent executions                         | List/get agents and runs                                                                           |
| Follow up                      | Post a session message                                                | `SendToAgentExecution`                                             | Create another run on the durable agent                                                            |
| Parallelism model              | Multiple sessions; MCP gather waits on a set                          | Multiple executions/environments                                   | Multiple agents; one active run per agent                                                          |
| Stop active work               | Terminate, sleep, or archive depending on interface                   | `StopAgentExecution`; environment stop                             | Cancel a run                                                                                       |
| Reversible retention           | Archive session; suspended sessions can resume                        | Stop/archive environment with persistent disk                      | Archive/unarchive agent                                                                            |
| Permanent removal              | Terminate/delete semantics                                            | Delete environment                                                 | Delete agent                                                                                       |
| Output access                  | Messages, attachments, PRs, structured output, events through MCP     | Transcript/conversation URLs, typed outputs, environment files     | Run result, Git state, artifacts, usage                                                            |
| Streaming                      | No public session SSE/WebSocket found                                 | Connect `WatchEvents` stream                                       | Per-run SSE                                                                                        |
| Outbound webhook               | No general session-completion webhook found                           | SCM/Automation webhooks are inbound triggers                       | Legacy v0 status webhook; v1 says coming soon                                                      |
| Public schema                  | OpenAPI v3                                                            | Generated protobuf/Connect method pages                            | OpenAPI v1 and SDK bridge protobuf                                                                 |
| SDKs                           | REST clients can be generated from OpenAPI                            | Python, TypeScript, Go                                             | TypeScript and Python plus language-neutral SDK Bridge                                             |
| Local agent CLI                | Yes                                                                   | External agents can use Ona environments; Ona manages environments | Yes                                                                                                |
| Hosted-agent CRUD CLI          | No complete cloud CRUD surface; `/handoff` creates cloud work         | CLI/API overlap is broad                                           | No documented equivalent to REST agent/run CRUD                                                    |
| Product management through MCP | Sessions, events, knowledge, playbooks, schedules, integration status | Not found                                                          | Built-in run diagnostics and environment setup/build operations; no public external endpoint found |

## Devin

### Interface Families

Devin exposes:

- A web application for cloud sessions.
- A local `devin` coding-agent CLI.
- An Agent Client Protocol server over stdio through `devin acp`.
- REST API v3 for organization and enterprise resources.
- A hosted Devin MCP server at `https://mcp.devin.ai/mcp`.
- MCP client support in cloud Devin and the CLI.
- Native source-control, Slack, Teams, Linear, and Jira integrations.
- Event-, schedule-, and webhook-triggered Automations.

API v3 became generally available in 2026. Legacy v1/v2 APIs and `apk_`/`apk_user_` credentials are
deprecated. Current credentials use the `cog_` prefix.

### REST Shape

The organization-scoped base path is:

```text
https://api.devin.ai/v3/organizations/{org_id}/...
```

Authentication is bearer-token based:

```http
Authorization: Bearer cog_...
```

Service-user keys are intended for automation. Personal access tokens act as a human user. Service
users with `ImpersonateOrgSessions` can set `create_as_user_id`.

The session creation shape includes a prompt and optional repository, knowledge, playbook, secret,
mode, platform, output, and lifecycle controls:

```http
POST /v3/organizations/{org_id}/sessions
Content-Type: application/json
Authorization: Bearer cog_...
```

```json
{
  "prompt": "Create a Python script that analyzes CSV data",
  "title": "Analyze CSV data",
  "repos": ["owner/repo"],
  "attachment_urls": ["https://example.test/input.csv"],
  "playbook_id": "playbook-id",
  "knowledge_ids": ["knowledge-id"],
  "secret_ids": ["secret-id"],
  "tags": ["automation"],
  "max_acu_limit": 20,
  "devin_mode": "normal",
  "resumable": true,
  "structured_output_schema": {},
  "structured_output_required": true
}
```

The current OpenAPI mode enum includes `normal`, `fast`, `lite`, `ultra`, and `fusion`, although
some prose pages mention fewer modes.

A session response includes durable identity, status, organization, timestamps, consumption, and
pull-request state:

```json
{
  "session_id": "devin-abc123",
  "url": "https://app.devin.ai/sessions/devin-abc123",
  "status": "running",
  "tags": [],
  "org_id": "org-id",
  "created_at": 0,
  "updated_at": 0,
  "acus_consumed": 0,
  "pull_requests": []
}
```

Documented session operations include:

```text
GET    /v3/organizations/{org_id}/sessions
POST   /v3/organizations/{org_id}/sessions
GET    /v3/organizations/{org_id}/sessions/{devin_id}
GET    /v3/organizations/{org_id}/sessions/{devin_id}/messages
POST   /v3/organizations/{org_id}/sessions/{devin_id}/messages
GET    /v3/organizations/{org_id}/sessions/{devin_id}/attachments
GET    /v3/organizations/{org_id}/sessions/{devin_id}/tags
POST   /v3/organizations/{org_id}/sessions/{devin_id}/tags
PUT    /v3/organizations/{org_id}/sessions/{devin_id}/tags
POST   /v3/organizations/{org_id}/sessions/{devin_id}/archive
DELETE /v3/organizations/{org_id}/sessions/{devin_id}
```

A follow-up message has this general shape:

```json
{
  "message": "Please also add unit tests",
  "attachment_urls": ["https://example.test/spec.png"],
  "message_as_user_id": "user-id"
}
```

Messages are chronological records with `event_id`, `source`, `message`, and `created_at`. List
operations use cursor pagination with `first`, `after`, `items`, `end_cursor`, and `has_next_page`.
Errors use an RFC 9457-style `application/problem+json` envelope.

### Session Lifecycle

Top-level status values are `new`, `claimed`, `running`, `exit`, `error`, `suspended`, and
`resuming`. `status_detail` distinguishes active work, user or approval waits, completion,
inactivity, quota/credit conditions, and errors.

Sending a message to a suspended session resumes it. Archiving preserves a session but prevents
further modification or resume. Termination is irreversible. A non-resumable session does not
preserve VM state after stopping. A session can report `running` with `status_detail: finished`, so
the two fields describe different layers of state.

### CLI Shape

The local CLI entry point is:

```text
devin [OPTIONS] [prompt]
```

Documented flags cover model selection, permission mode, sandboxing, continuation/resume,
non-interactive printing, prompt files, configuration, ATIF export, and workspace trust. Examples of
machine-readable commands include:

```bash
devin models list --format json
devin list --format json
devin list --format csv
```

Air-gapped CLI builds additionally expose `devin doctor --json`.

Local lifecycle commands create, list, resume, fork, rewind, rename, delete, and export sessions.
`/handoff [task]` creates a cloud Devin session carrying the repository, current branch,
conversation context, tracked changes, untracked changes, and optional task text. The cloud session
then runs independently.

`devin acp` runs the CLI as an ACP JSON-RPC server over stdio for compatible editor hosts. The
public `CognitionAI/devin-cli` repository points to documentation and does not expose the CLI
implementation or complete protocol schema.

### MCP Shape

Devin acts both as an MCP client and as a hosted MCP server.

Cloud Devin accepts stdio, Streamable HTTP, and legacy SSE MCP connections. The CLI stores user,
project, and local MCP configuration and exposes `add`, `list`, `get`, `remove`, `login`, `logout`,
`enable`, and `disable` commands. CLI MCP tools use names such as `mcp__<server>__<tool>`.

The hosted server uses Streamable HTTP:

```text
https://mcp.devin.ai/mcp
```

```http
Authorization: Bearer <cog_ credential>
X-Org-Id: <organization id>
```

`X-Org-Id` is needed for account-level personal tokens and enterprise service-user keys, but not for
organization-scoped service-user keys. The legacy `/sse` endpoint is deprecated.

Published hosted tools are grouped as follows:

| Group                    | Tools and functionality                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Repository documentation | `read_wiki_structure`, `read_wiki_contents`, `ask_question`, `list_available_repos`                                      |
| Sessions                 | `devin_session_create`, `devin_session_search`, `devin_session_interact`, `devin_session_events`, `devin_session_gather` |
| Playbooks                | `devin_playbook_manage` CRUD                                                                                             |
| Knowledge                | `devin_knowledge_manage` CRUD, folders, search, suggestions                                                              |
| Schedules                | `devin_schedule_manage` CRUD and notification settings                                                                   |
| Integrations             | `list_integrations` for native and MCP installation state                                                                |

`devin_session_interact` covers status, messages, sleep, termination, archive, attachments, and
tags. `devin_session_gather` blocks until multiple sessions settle. Exact MCP JSON Schemas are not
published on the documentation page; authenticated `tools/list` supplies them at runtime.

### Events and Integrations

REST clients can poll session and message state. The hosted MCP server exposes detailed event
listing, retrieval, search, and multi-session gathering. No public REST WebSocket, cloud-session SSE
stream, or general outbound completion webhook was identified.

Local CLI hooks cover `PreToolUse`, `PostToolUse`, `PermissionRequest`, `UserPromptSubmit`, `Stop`,
`PostCompaction`, `SessionStart`, and `SessionEnd`. Hook payloads carry `session_id`; turn-level
events also carry `prompt_id`. Hooks can block, approve, rewrite tool input, or add context.

Automations can react to Slack, GitHub, Linear, schedules, and incoming HTTPS webhooks. Automation
actions start sessions, message long-running sessions, monitor Slack, or notify external systems.
The v3 API exposes automation CRUD plus schema and template discovery.

## Ona

### Interface Families and Naming

Gitpod became Ona in September 2025, while current API service identifiers and several package or
download names retain Gitpod branding. Public services use the `gitpod.v1` namespace. Current SDK
1.x packages are incompatible with earlier 0.x clients.

Ona exposes:

- An `ona` CLI for environments, remote commands, SSH, ports, projects, tasks, services, prebuilds,
  webhooks, and organization controls.
- A Connect RPC API over protobuf JSON or protobuf.
- Python, TypeScript, and Go SDKs.
- MCP client/host support for tools available to agents.
- Source-control, Slack, Linear, and Automation integrations.

No public Ona-hosted MCP server for externally managing Ona resources was found.

### Connect API Shape

The base URL is:

```text
https://app.ona.com/api
```

Authentication uses a personal access token or service-account token:

```http
Authorization: Bearer <token>
```

Unary calls are HTTP `POST` requests whose paths encode the protobuf service and method:

```http
POST /api/gitpod.v1.EnvironmentService/ListEnvironments
```

Bodies use protobuf JSON conventions: lower-camel-case fields, symbolic enum names, strings for
64-bit integers, RFC 3339 timestamps, duration strings, base64 bytes, and rejection of unknown
fields. Server streams use Connect envelopes with `application/connect+json` or
`application/connect+proto`. Errors carry Connect codes and messages.

### Environment Resource

The environment API includes create, get, list, start, stop, and delete operations. Creation accepts
`spec`, `name`, `sessionId`, and `annotations`:

```http
POST /api/gitpod.v1.EnvironmentService/CreateEnvironment
```

```json
{
  "spec": {
    "specVersion": "1",
    "machine": { "class": "environment-class-uuid" },
    "timeout": { "disconnected": "7200s" }
  },
  "name": "task-environment",
  "sessionId": "optional-session-id",
  "annotations": {}
}
```

The response wraps an environment with `id`, `metadata`, `spec`, and `status`. If `sessionId` is
empty, Ona creates one implicitly. Environment phases include `CREATING`, `STARTING`, `RUNNING`,
`UPDATING`, `STOPPING`, `STOPPED`, `DELETING`, and `DELETED`.

List operations support token pagination and filters for runner, phase, creator, project, runner
kind, archive state, creation time, role, text, and session ID. Default page size is 25 and maximum
is 100.

Stopped environments preserve workspace and home-directory disk state. Archive is recoverable until
deletion; deletion is permanent. Dev-container rebuilds recreate most filesystem state while the
repository bind mount and uncommitted changes persist.

### Agent Execution Resource

Starting an agent uses:

```http
POST /api/gitpod.v1.AgentService/StartAgent
```

The request can identify an agent, code context, project, existing environment, repository or pull
request, execution name, workflow action, mode, runner, annotations, `sessionId`, model, reasoning,
and first-turn options. The response is:

```json
{
  "agentExecutionId": "execution-uuid"
}
```

An omitted `sessionId` creates a correlated session implicitly. Public API pages expose `sessionId`
on environments and executions, but no standalone `SessionService` or public session CRUD schema was
found.

Agent execution status contains phase and failure reason, conversation and transcript URLs, support
bundle URLs, conversation-streaming URLs, token and iteration usage, activity, environments, typed
outputs, model/mode, MCP statuses, waiting interests, goals, and subagent state. Phases are
`PENDING`, `RUNNING`, `WAITING_FOR_INPUT`, and `STOPPED`.

Interaction uses:

```http
POST /api/gitpod.v1.AgentService/SendToAgentExecution
```

The request identifies an execution and supplies one of user input, inter-agent message, wake event,
or control input. User input supports up to ten text/image items; PNG/JPEG images are base64 encoded
and limited to 4 MiB. The response is empty. Another method creates a temporary conversation token
for an execution, but the complete conversation-stream wire protocol is not documented on the method
pages.

### CLI Shape

The `ona` CLI supports browser login, token login, multiple host/organization contexts, and
machine-readable JSON or YAML output. Core environment commands include:

```bash
ona environment create <project-id>
ona environment create <repo-url> --class-id <class-id>
ona environment get <id-or-name>
ona environment list
ona environment start <id-or-name>
ona environment stop <id-or-name>
ona environment archive <id-or-name>
ona environment delete <id-or-name>
ona environment exec <id-or-name> -- <command>
ona environment ssh <id-or-name>
ona environment logs <id-or-name>
```

Creation normally waits for readiness; `--dont-wait` returns the ID immediately. `exec` uses an
EnvironmentOps API rather than SSH and propagates the remote process exit code. The CLI can infer
its current environment when run inside Ona. The documentation shows JSON examples but does not
publish a complete stability contract for CLI output schemas.

### MCP Shape

Organization administrators can register remote HTTP MCP servers. Authentication uses OAuth with
dynamic client registration or manually configured client metadata. Each user or service account
authenticates separately, so tool calls execute with that principal's permissions.

Repository-local MCP configuration lives at `.ona/mcp-config.json`:

```json
{
  "mcpServers": {
    "example": {
      "command": "npx",
      "args": ["-y", "example-mcp-server"],
      "env": { "TOKEN": "${exec:printenv TOKEN}" },
      "timeout": 30,
      "toolDenyList": ["dangerous_tool"]
    }
  },
  "globalTimeout": 30
}
```

`command` selects stdio and `url` selects HTTP; they are mutually exclusive. Configuration supports
arguments, headers, environment, working directory, timeout, tool deny lists, disabled state, and
runtime file/command expansion. Local MCP servers execute inside the environment. Configuration is
loaded at the beginning of each agent execution. Organization owners can disable MCP globally.

### Events and Integrations

Ona exposes a server-streaming Connect RPC:

```http
POST /api/gitpod.v1.EventService/WatchEvents
```

Streams are scoped to an organization or one environment. Each event reports an operation, resource
type, and resource ID rather than a full resource snapshot:

```json
{
  "operation": "RESOURCE_OPERATION_UPDATE_STATUS",
  "resourceType": "RESOURCE_TYPE_ENVIRONMENT",
  "resourceId": "resource-uuid"
}
```

Consumers retrieve current state through the corresponding Get RPC. Integrations include GitHub,
GitLab, Bitbucket Cloud, Azure DevOps, Slack, and Linear. Signed SCM webhooks trigger Automations.
The Workflow service can start an Automation with a workflow ID, context override, and up to ten
string parameters.

## Cursor Cloud Agents

### Interface Families

Cursor exposes:

- Web, desktop, and iOS Cloud Agent interfaces.
- Cloud Agents REST API v1, currently public beta.
- A legacy flat v0 API with webhooks.
- TypeScript and Python SDKs.
- A language-neutral Connect/protobuf SDK Bridge.
- A local/headless `agent` CLI and private cloud worker commands.
- MCP client support in local and cloud agents.
- Source-control, Slack, Teams, Linear, and Automation integrations.

The v1 resource model separates durable agent state from individual prompt runs.

### REST v1 Shape

The base URL is:

```text
https://api.cursor.com
```

Authentication accepts either Basic authentication with an API key as the username and an empty
password, or bearer authentication:

```http
Authorization: Basic base64(API_KEY:)
Authorization: Bearer API_KEY
```

Core endpoints are:

```text
POST   /v1/agents
GET    /v1/agents
GET    /v1/agents/{id}
DELETE /v1/agents/{id}
POST   /v1/agents/{id}/runs
GET    /v1/agents/{id}/runs
GET    /v1/agents/{id}/runs/{runId}
GET    /v1/agents/{id}/runs/{runId}/stream
POST   /v1/agents/{id}/runs/{runId}/cancel
GET    /v1/agents/{id}/usage
POST   /v1/agents/{id}/archive
POST   /v1/agents/{id}/unarchive
GET    /v1/agents/{id}/artifacts
GET    /v1/agents/{id}/artifacts/download
GET    /v1/models
GET    /v1/repositories
POST   /v1/sub-tokens
```

Self-hosted worker and pool controls retain `/v0/private-workers` paths. They include worker and
pool list/read operations, pool registration and deregistration, pending-request list and SSE watch,
atomic claim/release operations, and worker-utilization summaries. Pool service accounts can mint
one-hour user-scoped worker tokens through `/v1/sub-tokens`. The pending-request event stream is
explicitly best effort; periodic list results are its source of truth.

Creating an agent also enqueues its first run:

```json
{
  "prompt": { "text": "Add setup instructions" },
  "model": { "id": "composer-2.5", "params": [{ "id": "fast", "value": "true" }] },
  "name": "Update documentation",
  "repos": [{ "url": "https://github.com/acme/project", "startingRef": "main" }],
  "workOnCurrentBranch": false,
  "autoCreatePR": true,
  "mode": "agent",
  "envVars": { "STAGING_TOKEN": "..." },
  "mcpServers": [],
  "customSubagents": []
}
```

The response separates the resources:

```json
{
  "agent": {
    "id": "bc-uuid",
    "name": "Update documentation",
    "status": "ACTIVE",
    "env": { "type": "cloud" },
    "url": "https://cursor.com/agents/bc-uuid",
    "latestRunId": "run-uuid"
  },
  "run": {
    "id": "run-uuid",
    "agentId": "bc-uuid",
    "status": "CREATING"
  }
}
```

Creation supports up to 20 repositories, image inputs, model discovery, cloud/pool/machine
environments, branch controls, automatic pull requests, encrypted session environment variables,
inline MCP definitions, custom subagents, and agent/plan modes. A caller-supplied `agentId` provides
conflict-based idempotency. Current v1 repository schema text is GitHub-specific even though the
product supports other providers in other interfaces.

List operations use `items` and an omitted-when-finished `nextCursor`; default page size is 20 and
maximum is 100. Errors use a nested envelope with `code`, `message`, and optional help/provider
data.

### Agent and Run Lifecycle

A follow-up creates another run:

```http
POST /v1/agents/{id}/runs
```

```json
{
  "prompt": { "text": "Also add troubleshooting steps" },
  "mode": "agent",
  "mcpServers": []
}
```

Conversation and workspace state remain on the agent. Only one run can be active per agent; a
concurrent submission returns `409 agent_busy`. Run states are `CREATING`, `RUNNING`, `FINISHED`,
`ERROR`, `CANCELLED`, and `EXPIRED`.

Terminal runs expose duration, result text, and aggregate agent Git state. Cancellation is terminal
for the run, while another run can continue the same agent. Archive/unarchive is reversible and
idempotent. Delete is permanent. Documentation prose includes an `IDLE` agent state, while the
published OpenAPI summary enum omits it.

Artifacts are agent-scoped because the workspace persists across runs. Listing returns relative
paths, byte sizes, and timestamps. Download returns a 15-minute presigned URL. Usage can be read as
total and per-run input, output, cache-write, cache-read, and total token counts.

### Run SSE Shape

Each run has a `text/event-stream` endpoint. Documented event types are:

| Event                | Data                                                                    |
| -------------------- | ----------------------------------------------------------------------- |
| `status`             | Run ID and run status                                                   |
| `assistant`          | Text delta                                                              |
| `thinking`           | Thinking text delta                                                     |
| `tool_call`          | Call ID, name, running/completed state, optional args/result/truncation |
| `interaction_update` | Rich SDK-compatible interaction update                                  |
| `heartbeat`          | Empty object                                                            |
| `result`             | Terminal status, result text, duration, Git state                       |
| `error`              | Code and message                                                        |
| `done`               | Empty object                                                            |

Most events carry an opaque SSE ID. Clients reconnect with `Last-Event-ID`. An ID from another run
returns `invalid_last_event_id`. Stream retention is communicated dynamically through
`X-Cursor-Stream-Retention-Seconds`; after expiration, the endpoint can return `410 stream_expired`
and the run resource remains the durable source of terminal state.

### CLI and SDK Shape

The `agent` CLI is primarily a local/headless interface:

```bash
agent -p "Analyze this repository"
agent -p --force "Modify this repository"
```

It supports text, JSON, and NDJSON stream output; resume/continue; model and mode selection;
sandboxing; MCP approval; workspace trust; worktrees; and API-key authentication. Structured
terminal output includes result type, success/error state, durations, text, session ID, and optional
request ID. The CLI command reference does not expose hosted Cloud Agent CRUD matching the REST API.
`agent worker start` and `agent worker debug` manage self-hosted private workers.

The TypeScript and Python SDKs expose a shared create/send/stream/wait/cancel model across local and
cloud runtimes. SDK streams normalize `system`, `user`, `assistant`, `thinking`, `tool_call`,
`status`, `task`, `request`, and `usage` messages. Tool names and tool-specific arguments/results
are explicitly unstable; their surrounding event envelope is documented as stable.

The Cursor-owned SDK Bridge publishes a stable `sdk.v1` protobuf contract over Connect HTTP/1.1. It
includes agent, run, artifact, usage, identity, model, repository, control, custom-tool callback,
and custom-store services.

### MCP Shape

Cursor documents tools, prompts, resources, roots, elicitation, and MCP Apps over stdio, SSE, and
Streamable HTTP. Configuration is stored in project or user `mcp.json` files. The CLI exposes MCP
login, list, tool-list, enable, and disable commands.

Cloud Agent create and follow-up requests accept inline MCP definitions. Follow-up definitions
replace create-time inline definitions for that run. Remote HTTP MCP calls are backend-proxied, so
their credentials do not enter the agent VM. Stdio MCP servers run inside the VM and can access
their supplied configuration and environment. OAuth is per user. Enterprise policy can constrain
servers, URLs, commands, tools, and network destinations.

Cloud Agent runs also receive a built-in Cursor Cloud MCP diagnostics server. Its documented tools
include current-run and environment information, dashboard events, visible Cloud Agent listing,
batched run details and transcripts, automation lookup, environment build listing/logs/triggering,
environment configuration proposals, snapshots, and environment-setup action requests. Access is
checked per request: non-admin users see their own runs, while team administrators can inspect team
runs only where they already have repository and environment access. This server is documented as an
in-run built-in; no public URL for arbitrary external MCP clients is published.

The Cloud Agent capabilities page says custom Cloud Agent servers support HTTP and stdio but not
SSE, while the v1 OpenAPI accepts `sse`. This is a version-sensitive documentation inconsistency.

### Webhooks and Integrations

The current v1 documentation says webhooks are forthcoming. Legacy v0 supports HMAC-SHA256 signed
`statusChange` webhooks for `ERROR` and `FINISHED`, with delivery ID and event headers. Retry timing
and maximum attempts are not documented.

Integrations launch or follow up on agents through GitHub, GitLab, Azure DevOps, Bitbucket Cloud,
Slack, Teams, and Linear. Automations can react to schedules, source-control events, Slack, private
webhooks, Linear, Sentry, and PagerDuty. An individual agent can also subscribe to source-control,
Slack, Linear, or timer events for up to 180 days.

## Open-Inspect Current Behavior

### MCP Configuration

Open-Inspect currently models local MCP servers as command arrays plus optional environment and
remote servers as URLs plus optional headers. Servers have names, enabled state, and optional
repository scopes. D1 stores server metadata and encrypted credentials. API responses expose
credential presence flags rather than secret values.

Implemented control-plane routes are:

```text
GET    /mcp-servers
POST   /mcp-servers
GET    /mcp-servers/:id
PUT    /mcp-servers/:id
DELETE /mcp-servers/:id
```

These are installation-wide settings rather than user-owned resources. At sandbox spawn, enabled
global servers and repository-matching scoped servers are decrypted and translated into OpenCode MCP
configuration. Local `npx` packages may be preinstalled as a non-fatal optimization. A lookup or
decryption failure degrades to no MCP servers for that spawn rather than failing session creation.

No hosted Open-Inspect MCP server that exposes Open-Inspect resources to external MCP clients exists
in the inspected code.

### Session API

Open-Inspect already has internal HTTP and WebSocket interfaces for session creation, list/read,
prompts, events, artifacts, participants, pull-request creation/refresh metadata, attachments,
media, diffs, stop, title, archive/unarchive, delete, read state, and child sessions. It does not
have a dedicated pull-request read route.

Session creation accepts no repository, one repository, an ordered repository list, or a saved
environment, plus title, model, reasoning, managed skills, and provider-account selections. The
control plane derives caller identity and source-control credentials rather than trusting them from
the request.

The WebSocket interface uses a session-specific token and supports subscribe, prompt, stop, typing,
presence, and ping from clients, with state, sandbox, event, artifact, and presence messages from
the server. Child-session routes support create, list, get, cancel, and queued follow-up prompts.

### External Access Boundary

Browser calls pass through a Next.js backend-for-frontend that signs requests as `service:web` and
forwards the authenticated browser session. Bot workers use signed service identities. Sandboxes use
session-bound bearer tokens. Explicit external routes accept 30-day revocable CLI bearer credentials
issued through browser-approved device authorization and resolve them directly to canonical human
principals. CLI credentials are not accepted by internal browser, service, or sandbox routes.

The first-party `oi` CLI and its local MCP server currently cover repository-less text session
create/list/get/prompt/stop/events/wait. Existing sandbox-local commands include `upload-media` and
`oi-git-sign`.

The current authorization model is one workspace per deployment with a code-owned RBAC permission
registry. Owner, Administrator, Member, Viewer, and custom roles are enforced by the control plane
through explicit route authorization metadata. Suspended or unassigned users fail closed; bot calls
are bounded by both the acting user's permissions and a fixed service ceiling.

Session permissions are intentionally workspace-wide: creator and participant records are
attribution rather than access boundaries. `sessions.read`, `sessions.collaborate`,
`sessions.lifecycle`, `sessions.sandbox_access`, and `sessions.delete` each apply across all
sessions. Members hold all five grants, while Viewers hold read-only. Existing browser session
WebSockets use a non-renewed five-minute authorization lease, and mutating commands recheck their
specific permission.

## Existing Interface Patterns

The researched systems repeatedly expose the following current patterns:

- A durable work container (`session`, `agent`, or correlated `sessionId`) distinct from, or paired
  with, one or more execution turns.
- Separate soft-retention and permanent-removal operations.
- A follow-up operation that preserves conversation and workspace context.
- Cursor-based pagination for potentially large collections.
- Service-account credentials for automation and user credentials for attributed actions.
- Machine-readable status plus a more detailed reason or phase.
- Artifact/output access outside the text conversation.
- Repository context supplied at creation and Git/PR state returned as output.
- Event delivery through polling, server streams, SSE, MCP tools, or product integrations.
- MCP configuration at user, project/repository, organization, or per-execution scope.
- Native chat, ticketing, and source-control integrations as alternative command surfaces.
- Discovery endpoints or generated schemas for models, automation event types, RPC methods, or MCP
  tools.

Only Devin currently documents a hosted MCP management surface spanning the product's core
resources. Ona's broad CLI mirrors much of its environment API. Cursor exposes the clearest public
separation between durable conversation/workspace state and individual executions, along with the
most detailed public run stream.

## Constraints and Invariants

- Devin's hosted MCP server requires current `cog_` credentials; legacy keys are unsupported.
- Ona's API is Connect/protobuf rather than conventional REST and rejects unknown protobuf JSON
  fields.
- Cursor API v1 is public beta and explicitly permits interface changes before general availability.
- Cursor permits only one active run per durable agent.
- Ona session identity is visible as correlation metadata but not as an independently managed public
  resource.
- MCP stdio servers in all three products run within an agent or environment execution boundary;
  remote-server credential placement differs by product.
- Public integration behavior can be broader than the provider coverage represented in one API
  schema, particularly Cursor's GitHub-specific v1 repository shape.
- Open-Inspect's current HTTP routes are protected by browser/session, signed service, or sandbox
  identities rather than a general external API key.
- Open-Inspect human and service routes declare code-owned RBAC authorization policies; session
  permissions are workspace-wide rather than creator/participant-scoped.
- Open-Inspect MCP credentials are available inside applicable sandboxes after spawn-time
  resolution.
- Open-Inspect MCP changes are not live-reloaded into already running OpenCode processes.

## Known Gaps and Risks

### Public Documentation Gaps

- Devin does not publish the exact input/output schemas of its hosted MCP tools on the overview
  page.
- Devin does not document a public cloud session SSE/WebSocket or general outbound completion
  webhook.
- Ona does not document a standalone session service or complete conversation stream protocol.
- Ona does not publish a formal stability contract for all CLI JSON output.
- Cursor does not yet expose v1 webhooks and does not document full retry guarantees for v0
  webhooks.
- Cursor run SSE resume semantics are documented, but no exact delivery guarantee is stated.
- All three products have some naming, schema, or transport inconsistencies across documentation
  pages.

### Open-Inspect Gaps Visible in Current State

- No hosted MCP server exposes Open-Inspect sessions, events, environments, integrations, or
  configuration to external MCP clients.
- Increment 1 supports only repository-less text sessions; repository/environment discovery and
  targets, attachments, skills/provider selections, children, diffs, artifacts, and pull-request
  reads remain outside the implemented external surface.
- Event observation uses sanitized pinned snapshots and a bounded forward change feed with monotonic
  checkpoints, coalesced upserts, and delete tombstones. Changes are retained for up to 24 hours and
  at most 50,000 revisions per session; expired checkpoints require a fresh snapshot. Hosted live
  transport is not implemented.
- MCP configuration is installation-wide and has no separate per-tool permission layer.
- MCP CRUD is gated by `mcp_servers.read` and `mcp_servers.manage`.
- Direct API callers can omit the MCP update revision even though shared types and the web UI treat
  it as required.
- Session authorization is intentionally workspace-wide; RBAC does not provide tenant-, project-,
  repository-, or creator-isolated session access.

## Open Questions

- The full MCP/CLI product contract is documented in `docs/plans/mcp-cli.md`; device credentials,
  checkpointed event polling, and the Increment 1 CLI/MCP session loop are implemented, while later
  V1 capabilities and live event transport remain proposed.
- The merged RBAC design deliberately grants workspace-wide session access, so the external surface
  inherits broad session authority from each role rather than adding per-session grants.

## Evidence

### Open-Inspect

- `packages/shared/src/types/integrations.ts`: Local/remote MCP server types, metadata, credentials,
  repository scopes, and revision-bearing request types.
- `packages/control-plane/src/routes/mcp-servers.ts`: MCP CRUD routes and route policy.
- `packages/control-plane/src/db/mcp-servers.ts`: Encryption, persistence, scope resolution, and
  optional update revision enforcement.
- `packages/control-plane/src/routes/session-create.ts`: Session creation and source-control
  enrichment workflow.
- `packages/shared/src/types/session-api.ts`: Session request and prompt contracts.
- `packages/control-plane/src/routes/session-runtime-proxy.ts`: Runtime, lifecycle, event, artifact,
  participant, diff, attachment, media, and pull-request route forwarding.
- `packages/control-plane/src/routes/session-child-spawn.ts`: Child-session creation constraints.
- `packages/control-plane/src/routes/session-children.ts`: Child list, read, cancel, and follow-up
  interfaces.
- `packages/control-plane/src/routes/session-ws-token.ts`: Session-specific WebSocket admission.
- `packages/control-plane/src/auth/authenticate.ts`: User, service, and sandbox authentication.
- `packages/shared/src/rbac.ts`: Code-owned permission registry and built-in role grants.
- `packages/control-plane/src/authorization/service.ts`: Effective permission and suspension checks.
- `docs/AUTH.md`: Current workspace-wide session authorization and role behavior.
- `packages/web/src/lib/control-plane.ts`: Browser BFF request signing and cookie forwarding.
- `terraform/d1/migrations/0050_purge_retired_api_tokens.sql`: Removal of historical general API
  tokens.
- `packages/sandbox-runtime/src/sandbox_runtime/opencode_server.py`: MCP translation and runtime
  permission configuration.
- `packages/control-plane/README.md`: Current documented HTTP and WebSocket interface inventory.

### Devin Sources

All external sources were accessed 2026-08-29.

- [API overview](https://docs.devin.ai/api-reference/overview.md)
- [API authentication](https://docs.devin.ai/api-reference/authentication.md)
- [API migration guide](https://docs.devin.ai/api-reference/getting-started/migration-guide.md)
- [API release notes](https://docs.devin.ai/api-reference/release-notes.md)
- [OpenAPI v3](https://docs.devin.ai/v3-openapi.yaml)
- [Create session](https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions.md)
- [List sessions](https://docs.devin.ai/api-reference/v3/sessions/organizations-sessions.md)
- [Get session](https://docs.devin.ai/api-reference/v3/sessions/get-organizations-session.md)
- [List messages](https://docs.devin.ai/api-reference/v3/sessions/get-organizations-session-messages.md)
- [Send message](https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions-messages.md)
- [CLI overview](https://docs.devin.ai/cli/index.md)
- [CLI commands](https://docs.devin.ai/cli/reference/commands.md)
- [CLI handoff](https://docs.devin.ai/cli/handoff.md)
- [CLI MCP](https://docs.devin.ai/cli/extensibility/mcp/configuration.md)
- [CLI lifecycle hooks](https://docs.devin.ai/cli/extensibility/hooks/lifecycle-hooks.md)
- [Hosted Devin MCP](https://docs.devin.ai/work-with-devin/devin-mcp.md)
- [MCP client configuration](https://docs.devin.ai/work-with-devin/mcp.md)
- [Automations](https://docs.devin.ai/product-guides/automations.md)
- [Integrations overview](https://docs.devin.ai/integrations/overview.md)
- [Official Devin CLI repository](https://github.com/CognitionAI/devin-cli)

### Ona Sources

All external sources were accessed 2026-08-29.

- [Ona API reference](https://ona.com/docs/api-reference)
- [SDK migration](https://ona.com/docs/api-reference/sdk-migration.md)
- [Create environment](https://ona.com/docs/api-reference/generated/environment/create-environment.md)
- [List environments](https://ona.com/docs/api-reference/generated/environment/list-environments.md)
- [Start agent](https://ona.com/docs/api-reference/generated/agent/start-agent.md)
- [Get agent execution](https://ona.com/docs/api-reference/generated/agent/get-agent-execution.md)
- [Send to agent execution](https://ona.com/docs/api-reference/generated/agent/send-to-agent-execution.md)
- [Watch events](https://ona.com/docs/api-reference/generated/event/watch-events.md)
- [CLI guide](https://ona.com/docs/ona/integrations/cli.md)
- [CLI reference](https://ona.com/docs/ona/reference/cli.md)
- [SDK guide](https://ona.com/docs/ona/integrations/sdk.md)
- [MCP servers](https://ona.com/docs/ona/mcp.md)
- [Integrations overview](https://ona.com/docs/ona/integrations/overview.md)
- [Environment lifecycle](https://ona.com/docs/ona/environments/overview.md)
- [Rename announcement](https://ona.com/stories/gitpod-is-now-ona)
- [TypeScript SDK repository](https://github.com/gitpod-io/gitpod-sdk-typescript)
- [Go SDK repository](https://github.com/gitpod-io/gitpod-sdk-go)

### Cursor Sources

All external sources were accessed 2026-08-29.

- [Cloud Agents overview](https://cursor.com/docs/cloud-agent)
- [Cloud Agent capabilities](https://cursor.com/docs/cloud-agent/capabilities)
- [Cloud Agents API reference](https://cursor.com/docs/cloud-agent/api/endpoints)
- [Cloud Agents OpenAPI](https://cursor.com/docs-static/cloud-agents-openapi.yaml)
- [API overview](https://cursor.com/docs/api)
- [Legacy v0 API](https://cursor.com/docs/cloud-agent/api/v0)
- [Webhooks](https://cursor.com/docs/cloud-agent/api/webhooks)
- [TypeScript SDK](https://cursor.com/docs/sdk/typescript)
- [Python SDK](https://cursor.com/docs/sdk/python)
- [SDK Bridge repository](https://github.com/cursor/sdk-bridge)
- [CLI command reference](https://cursor.com/docs/cli/reference/parameters)
- [CLI headless mode](https://cursor.com/docs/cli/headless)
- [CLI output](https://cursor.com/docs/cli/reference/output-format)
- [MCP documentation](https://cursor.com/docs/mcp)
- [Automations](https://cursor.com/docs/cloud-agent/automations)
- [Slack integration](https://cursor.com/docs/integrations/slack)
- [Linear integration](https://cursor.com/docs/integrations/linear)
