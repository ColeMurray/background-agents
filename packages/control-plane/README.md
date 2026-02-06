# Open-Inspect Control Plane

Cloudflare Workers + Durable Objects control plane for session management and real-time streaming.

## Overview

The control plane provides:

- **Session Management**: SQLite-backed Durable Objects for each session
- **Real-time Streaming**: WebSocket connections with hibernation support
- **Multi-client Sync**: Web, Slack, extension clients all see the same state
- **GitHub Integration**: GitHub App for repository access
- **Token Encryption**: AES-256-GCM encryption for GitHub tokens at rest
- **Repo Secrets**: Encrypted repo-scoped secrets stored in D1, injected into sandboxes as env vars

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
│  │              D1 Database (repo-scoped secrets)              │   │
│  └───────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

## API Endpoints

### Health

| Endpoint  | Method | Description  |
| --------- | ------ | ------------ |
| `/health` | GET    | Health check |

### Sessions

| Endpoint                     | Method    | Description              |
| ---------------------------- | --------- | ------------------------ |
| `/sessions`                  | GET       | List user's sessions     |
| `/sessions`                  | POST      | Create new session       |
| `/sessions/:id`              | GET       | Get session state        |
| `/sessions/:id`              | DELETE    | Delete session           |
| `/sessions/:id/prompt`       | POST      | Enqueue prompt           |
| `/sessions/:id/stop`         | POST      | Stop execution           |
| `/sessions/:id/ws`           | WebSocket | Real-time connection     |
| `/sessions/:id/events`       | GET       | Paginated events         |
| `/sessions/:id/artifacts`    | GET       | List artifacts           |
| `/sessions/:id/participants` | GET/POST  | Manage participants      |
| `/sessions/:id/messages`     | GET       | List messages            |
| `/sessions/:id/pr`           | POST      | Create pull request      |
| `/sessions/:id/ws-token`     | POST      | Generate WebSocket token |
| `/sessions/:id/archive`      | POST      | Archive session          |
| `/sessions/:id/unarchive`    | POST      | Unarchive session        |

### Create PR Payload

`POST /sessions/:id/pr` accepts:

- `title` (required)
- `body` (required)
- `baseBranch` (optional)
- `headBranch` (optional)

When `headBranch` is omitted, control-plane resolves it from session state and finally falls back to
the generated `open-inspect/<session>` branch.

### Repositories

| Endpoint                           | Method | Description          |
| ---------------------------------- | ------ | -------------------- |
| `/repos`                           | GET    | List repositories    |
| `/repos/:owner/:name/metadata`     | GET    | Get repo metadata    |
| `/repos/:owner/:name/metadata`     | PUT    | Update repo metadata |
| `/repos/:owner/:name/secrets`      | GET    | List secret keys     |
| `/repos/:owner/:name/secrets`      | PUT    | Upsert secrets       |
| `/repos/:owner/:name/secrets/:key` | DELETE | Delete a secret      |

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
- `sandbox`: Modal sandbox state
- `ws_client_mapping`: WebSocket ID to participant mapping (for hibernation recovery)

See `src/session/schema.ts` for full schema.

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

| Token            | Used For    | Sent to Sandbox? | Access Scope                     |
| ---------------- | ----------- | ---------------- | -------------------------------- |
| GitHub App Token | Clone, push | Yes (ephemeral)  | All repos where App is installed |
| User OAuth Token | Create PRs  | No (server-only) | User's accessible repos          |

If a `create-pr` request is triggered by a participant without a user OAuth token (for example,
Slack-created sessions), the control-plane still pushes the branch with the GitHub App token and
returns a manual GitHub `pull/new` URL instead of failing the request.

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
