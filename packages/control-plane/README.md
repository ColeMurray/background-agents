# Open-Inspect Control Plane

Cloudflare Workers + Durable Objects control plane for session management and real-time streaming.

## Overview

The control plane provides:

- **Session Management**: SQLite-backed Durable Objects for each session
- **Real-time Streaming**: WebSocket connections with hibernation support
- **Multi-client Sync**: Web, Slack, extension clients all see the same state
- **GitHub Integration**: GitHub App for repository access
- **Token Encryption**: AES-256-GCM encryption for GitHub tokens at rest
- **Secrets**: Encrypted global, repo-scoped, and environment-scoped secrets stored in D1, injected
  into sandboxes as env vars
- **Environments**: Named repository sets with their own secrets and prebuilt images, stored in D1

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Cloudflare Workers                            │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                   API Gateway (router.ts)                 │   │
│  │   POST /sessions  │  GET /sessions/:id  │  WebSocket      │   │
│  └─────────────────────────────┬────────────────────────────┘   │
│                                │                                 │
│  ┌─────────────────────────────┴────────────────────────────┐   │
│  │              Durable Objects (per session)                │   │
│  │  ┌────────────────┐  ┌──────────────┐  ┌──────────────┐  │   │
│  │  │   SQLite DB    │  │  WebSocket   │  │    Event     │  │   │
│  │  │ - session      │  │    Hub       │  │   Stream     │  │   │
│  │  │ - participants │  │ (hibernation)│  │              │  │   │
│  │  │ - messages     │  └──────────────┘  └──────────────┘  │   │
│  │  │ - events       │                                       │   │
│  │  │ - artifacts    │                                       │   │
│  │  │ - sandbox      │                                       │   │
│  │  │ - ws_mapping   │                                       │   │
│  │  └────────────────┘                                       │   │
│  └───────────────────────────────────────────────────────────┘   │
│  ┌───────────────────────────────────────────────────────────┐   │
│  │   D1 Database (sessions index, environments, automations,   │   │
│  │              image builds, encrypted secrets)               │   │
│  └───────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

## API Endpoints

### Health

| Endpoint  | Method | Description  |
| --------- | ------ | ------------ |
| `/health` | GET    | Health check |

### Sessions

| Endpoint                        | Method    | Description                    |
| ------------------------------- | --------- | ------------------------------ |
| `/sessions`                     | GET       | List user's sessions           |
| `/sessions`                     | POST      | Create new session             |
| `/sessions/:id`                 | GET       | Get session state              |
| `/sessions/:id`                 | DELETE    | Delete session                 |
| `/sessions/:id/prompt`          | POST      | Enqueue prompt                 |
| `/sessions/:id/stop`            | POST      | Stop execution                 |
| `/sessions/:id/ws`              | WebSocket | Real-time connection           |
| `/sessions/:id/events`          | GET       | Paginated events               |
| `/sessions/:id/artifacts`       | GET       | List artifacts                 |
| `/sessions/:id/participants`    | GET/POST  | Manage participants            |
| `/sessions/:id/messages`        | GET       | List messages                  |
| `/sessions/:id/pr`              | POST      | Create pull request            |
| `/sessions/:id/scm-credentials` | POST      | Broker sandbox git credentials |
| `/sessions/:id/ws-token`        | POST      | Generate WebSocket token       |
| `/sessions/:id/archive`         | POST      | Archive session                |
| `/sessions/:id/unarchive`       | POST      | Unarchive session              |

### Create PR Payload

`POST /sessions/:id/pr` accepts:

- `title` (required)
- `body` (required)
- `baseBranch` (optional)
- `headBranch` (optional)

When `headBranch` is omitted, control-plane resolves it from session state and finally falls back to
the generated `open-inspect/<session>` branch.

### SCM Credentials

`POST /sessions/:id/scm-credentials` is a sandbox-authenticated endpoint used by the in-sandbox git
credential helper. It returns fresh SCM credentials for git operations in this shape:

```json
{
  "username": "x-access-token",
  "password": "<short-lived-token>",
  "expires_at_epoch_ms": 1730000000000
}
```

Common failures are `401` for a missing or invalid sandbox token, `404` when the session no longer
exists, and `5xx` when provider configuration or upstream token minting fails. Source-control
providers must implement `generateCredentialHelperAuth` before helper-backed sandbox git auth works
for that provider.

### Repositories

| Endpoint                           | Method | Description          |
| ---------------------------------- | ------ | -------------------- |
| `/repos`                           | GET    | List repositories    |
| `/repos/:owner/:name/metadata`     | GET    | Get repo metadata    |
| `/repos/:owner/:name/metadata`     | PUT    | Update repo metadata |
| `/repos/:owner/:name/secrets`      | GET    | List secret keys     |
| `/repos/:owner/:name/secrets`      | PUT    | Upsert secrets       |
| `/repos/:owner/:name/secrets/:key` | DELETE | Delete a secret      |

### Environments

An environment is a named, ordered repository set (1–10 repositories, first = primary) that sessions
can be launched from. `POST /sessions` accepts exactly one of the scalar repo fields
(`repoOwner`/`repoName`), a `repositories` list (ad-hoc multi-repository session), or an
`environmentId`.

| Endpoint                           | Method | Description                                                                     |
| ---------------------------------- | ------ | ------------------------------------------------------------------------------- |
| `/environments`                    | GET    | List environments                                                               |
| `/environments`                    | POST   | Create environment                                                              |
| `/environments/:id`                | GET    | Get environment with repositories                                               |
| `/environments/:id`                | PUT    | Update name, description, repositories, prebuild, or Slack channel associations |
| `/environments/:id`                | DELETE | Delete environment (sessions keep their snapshot)                               |
| `/environments/:id/secrets`        | GET    | List environment secret keys                                                    |
| `/environments/:id/secrets`        | PUT    | Upsert environment secrets                                                      |
| `/environments/:id/secrets/:key`   | DELETE | Delete an environment secret                                                    |
| `/environments/:id/secrets/import` | POST   | Copy selected keys from a repository of the env                                 |

Environment image builds (prebuilds of the whole environment) are managed via
`/environment-images/status`, `/environment-images/trigger/:id`, and the build callback routes,
mirroring the repo-image endpoints.

### Automations

| Endpoint                          | Method | Description                                                             |
| --------------------------------- | ------ | ----------------------------------------------------------------------- |
| `/automations`                    | GET    | List automations                                                        |
| `/automations`                    | POST   | Create automation                                                       |
| `/automations/:id`                | GET    | Get automation                                                          |
| `/automations/:id`                | PUT    | Update automation                                                       |
| `/automations/:id`                | DELETE | Soft-delete automation                                                  |
| `/automations/:id/pause`          | POST   | Pause (stop firing)                                                     |
| `/automations/:id/resume`         | POST   | Resume; resets the failure counter                                      |
| `/automations/:id/trigger`        | POST   | Fire now → `201 {invocationId, runs}`, `409` if an invocation is active |
| `/automations/:id/invocations`    | GET    | Run history: one entry per firing, with child runs                      |
| `/automations/:id/runs/:runId`    | GET    | Get one run                                                             |
| `/automations/:id/regenerate-key` | POST   | Rotate a webhook automation's API key                                   |

An automation selects 0–10 repositories (`repositories: [{repoOwner, repoName, baseBranch?}]`;
multi-repo selections require a schedule trigger) — or binds an environment instead
(`environmentId`, mutually exclusive with a non-empty selection and unavailable to the repo-scoped
`github_event`/`linear_event` triggers). Each firing records one **invocation**; a non-skipped
invocation fans out into one **run** per repository, and each run links to one session. Runs
snapshot their repository at firing time, so editing the selection never rewrites history. An
environment-bound firing has exactly one run whose session opens the environment's full workspace,
resolved at launch time. See [docs/MULTI_REPO_AUTOMATIONS.md](../../docs/MULTI_REPO_AUTOMATIONS.md)
for the design decisions.

An invocation's status is **derived from its child runs, never stored**: no children → `skipped`;
any child starting/running → `starting`/`running`; all terminal → `completed` (none failed),
`failed` (none completed), `partial_failed` (a mix), or `skipped` (all skipped).

## WebSocket Protocol

### Client → Server Messages

| Type        | Description        | Payload                     |
| ----------- | ------------------ | --------------------------- |
| `ping`      | Health check       | `{}`                        |
| `subscribe` | Join session       | `{ token, clientId }`       |
| `prompt`    | Send prompt        | `{ content, attachments? }` |
| `stop`      | Stop execution     | `{}`                        |
| `typing`    | User typing (warm) | `{}`                        |
| `presence`  | Update presence    | `{ status, cursor? }`       |

### Server → Client Messages

| Type               | Description                   |
| ------------------ | ----------------------------- |
| `pong`             | Health check response         |
| `subscribed`       | Confirm subscription          |
| `prompt_queued`    | Confirm prompt queued         |
| `sandbox_event`    | Event from sandbox            |
| `presence_sync`    | Full presence state           |
| `presence_update`  | Presence change               |
| `presence_leave`   | Participant disconnected      |
| `sandbox_spawning` | Sandbox is being created      |
| `sandbox_warming`  | Sandbox warming               |
| `sandbox_status`   | Sandbox status update         |
| `sandbox_ready`    | Sandbox ready                 |
| `sandbox_error`    | Sandbox error occurred        |
| `sandbox_warning`  | Sandbox warning message       |
| `sandbox_restored` | Restored from snapshot        |
| `artifact_created` | New artifact (PR, screenshot) |
| `snapshot_saved`   | Filesystem snapshot saved     |
| `session_status`   | Session status change         |
| `error`            | Error occurred                |

## Development

### Prerequisites

- Node.js 22+
- Terraform (for deployment)

### Setup

```bash
cd packages/control-plane
npm install
```

### Build

```bash
npm run build
# Outputs to dist/index.js
```

### Deploy

Deployment is managed via Terraform. See [terraform/README.md](../../terraform/README.md) for
details.

All secrets and environment variables are configured through Terraform's `terraform.tfvars` file.

## SQLite Schema

Each session gets its own SQLite database with:

- `session`: Core session state (repo, branch, status)
- `participants`: Users with encrypted GitHub tokens
- `messages`: Prompt queue and history
- `events`: Agent events (tool calls, tokens)
- `artifacts`: PRs, screenshots, previews
- `sandbox`: selected backend sandbox state
- `ws_client_mapping`: WebSocket ID to participant mapping (for hibernation recovery)

See `src/session/schema.ts` for full schema.

## D1 Schema (sessions, environments, automations)

Shared state lives in the D1 database (migrations in `terraform/d1/migrations/`). Beyond the
sessions index, repo metadata, and encrypted secrets:

- `session_repositories`: a session's ordered repository list (position 0 = primary; single-repo
  sessions also mirror the primary onto the session row's scalar columns).
- `environments`: named repository sets (name, description, prebuild flag, Slack channel
  associations).
- `environment_repositories`: the environment's ordered repository list with per-repository base
  branch.
- `environment_secrets`: environment-scoped secrets, mirroring `repo_secrets` (same encryption key
  and caps).
- `environment_images`: prebuilt environment image builds — provider artifact id, per-repository
  SHAs, a repositories fingerprint for spawn matching, and the runtime version floor check.

Automations:

- `automations`: trigger, schedule, model, instructions, failure counter, and the optional
  `environment_id` binding (shared-workspace mode). The repository selection lives in
  `automation_repositories`, not on this row; a bound environment implies an empty selection.
- `automation_repositories`: the live repository selection (0–10 rows per automation), unique per
  `(automation_id, repo_owner, repo_name)`.
- `automation_invocations`: one thin row per firing — source, firing-scoped `trigger_key` (event
  dedup, UNIQUE per automation) and `concurrency_key`, `skip_reason` for childless skips, and the
  `failure_counted_at` compare-and-set stamp that makes auto-pause accounting exactly-once. Status
  is **not** stored; it is derived from child runs (`DERIVED_INVOCATION_STATUS_SQL` in
  `src/db/automation-store.ts` is the single definition).
- `automation_runs`: one row per repository per invocation, linked by `invocation_id`, carrying the
  firing-time repository snapshot (`repo_owner/repo_name/repo_id/base_branch`) and the session
  linkage. Firing keys live on the invocation, not the run.

## Token Encryption

GitHub OAuth tokens are encrypted at rest using AES-256-GCM:

```typescript
import { encryptToken, decryptToken } from "./auth/crypto";

// Encrypt before storing
const encrypted = await encryptToken(accessToken, env.TOKEN_ENCRYPTION_KEY);

// Decrypt when needed
const token = await decryptToken(encrypted, env.TOKEN_ENCRYPTION_KEY);
```

## Security Model

> **Single-Tenant Only**: This control plane is designed for single-tenant deployment where all
> users are trusted members of the same organization.

### GitHub App Token Flow

The system uses two types of GitHub tokens:

| Token            | Used For           | Delivery                      | Access Scope                     |
| ---------------- | ------------------ | ----------------------------- | -------------------------------- |
| GitHub App Token | Clone, fetch, push | Brokered to credential helper | All repos where App is installed |
| User OAuth Token | Create PRs         | Server-only                   | User's accessible repos          |

Fresh and repo-image sandboxes do not receive a long-lived `GITHUB_TOKEN`, `GITHUB_APP_TOKEN`, or
`VCS_CLONE_TOKEN` for normal git operations. Git invokes the sandbox credential helper, which calls
`/sessions/:id/scm-credentials` with the sandbox auth token and receives short-lived credentials on
demand. Legacy snapshots and one-shot image builds may still receive env-token fallbacks for
compatibility. The helper preserves the existing installation-wide model by serving credentials for
HTTPS git requests to the configured SCM host, including setup/start hooks that clone auxiliary
private repos. This avoids stale embedded credentials in long-running sessions and Daytona
persistent resumes; Modal snapshot restores still mint a fresh fallback token during restore.

If a `create-pr` request is triggered by a participant without a user OAuth token (for example,
Slack-created or Google-login sessions), the sandbox can still push the branch with brokered GitHub
App credentials and the control plane returns a manual GitHub `pull/new` URL instead of failing the
request.

### Why This Matters

- **No per-user repo access validation**: When a session is created, the system does not verify that
  the user has access to the requested repository
- **Shared GitHub App installation**: A single `GITHUB_APP_INSTALLATION_ID` is used for all users
- **Trust boundary is the organization**: All users with access to the web app can work with any
  repository the GitHub App is installed on

### Configuration

All secrets are configured via Terraform. Required secrets include:

- `GITHUB_APP_ID` - GitHub App ID
- `GITHUB_APP_PRIVATE_KEY` - GitHub App private key (PKCS#8 format)
- `GITHUB_APP_INSTALLATION_ID` - Single installation for all users
- `REPO_SECRETS_ENCRYPTION_KEY` - AES-GCM key for encrypting repo secrets in D1

Optional variables:

- `SCM_PROVIDER` - Source control provider for this deployment (`github`, `bitbucket`, or `gitlab`,
  default: `github`). `bitbucket` returns explicit `501 Not Implemented` responses until
  implemented.
- `GITLAB_ACCESS_TOKEN` - Personal Access Token for GitLab API access (required when
  `SCM_PROVIDER=gitlab`). Must have `read_api` scope for reads and `api` scope to create merge
  requests and push branches.
- `GITLAB_NAMESPACE` - GitLab group namespace to scope repository listing (optional). When set,
  `GET /repos` lists projects within the group instead of all projects the token has access to.

See
[terraform/environments/production/terraform.tfvars.example](../../terraform/environments/production/terraform.tfvars.example)
for the complete list.

### Deployment Recommendations

1. Deploy behind SSO/VPN to restrict access to authorized employees
2. Install the GitHub App only on repositories you want the system to access
3. Use GitHub's "Only select repositories" option when installing the App

## Verification Criteria

| Criterion                          | Test Method                           |
| ---------------------------------- | ------------------------------------- |
| Durable Object creates with SQLite | Create session, verify tables exist   |
| WebSocket hibernation works        | Connect, idle 60s, send message       |
| Multiple clients sync state        | Connect 2 clients, verify sync        |
| GitHub OAuth flow completes        | Complete OAuth, verify token stored   |
| Token encryption works             | Store/retrieve token, verify matches  |
| Prompt queue ordering              | Enqueue 3 prompts, verify FIFO        |
| Session survives DO eviction       | Create, wait, reconnect, verify state |
| Ping/pong WebSocket health         | Send ping, verify pong                |
| Typing triggers sandbox warm       | Send typing, verify warming event     |
| Presence sync on connect           | Connect 2 clients, verify presence    |
