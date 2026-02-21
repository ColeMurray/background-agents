# Open-Inspect Modal Infrastructure

Modal-based sandbox infrastructure for the Open-Inspect coding agent system.

## Overview

This package provides the data plane for Open-Inspect:

- **Sandboxes**: Isolated development environments running OpenCode
- **Images**: Pre-built container images with all development tools
- **Snapshots**: Filesystem snapshots for fast startup and session persistence
- **Scheduler**: Image rebuilding infrastructure (currently disabled)

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Session Sandbox                              │
│  ┌──────────────────┐  ┌─────────────────┐  ┌───────────────┐  │
│  │  Supervisor      │  │  OpenCode       │  │  Bridge       │  │
│  │  (entrypoint.py) │──│  Server         │──│  (bridge.py)  │  │
│  └──────────────────┘  └─────────────────┘  └───────────────┘  │
│           │                    │                    │           │
│           └────────────────────┼────────────────────┘           │
│                                │                                │
│                        WebSocket to                             │
│                      Control Plane                              │
└─────────────────────────────────────────────────────────────────┘
```

## Components

### Images (`src/images/`)

Base image definition with:
- Debian slim + git, curl, build-essential
- Node.js 22, pnpm, Bun
- Python 3.12 with uv
- OpenCode CLI
- Playwright + headless Chrome

### Sandbox (`src/sandbox/`)

- **manager.py**: Sandbox lifecycle (create, warm, snapshot)
- **entrypoint.py**: Supervisor process (runs as PID 1)
- **bridge.py**: WebSocket bridge to control plane
- **types.py**: Event and configuration types

### Registry (`src/registry/`)

- **models.py**: Repository and snapshot data models
- **store.py**: Persistent metadata storage

### Auth (`src/auth/`)

- **github_app.py**: GitHub App token generation for repo access
- **internal.py**: HMAC authentication for control plane requests

### API (`src/`)

- **web_api.py**: HTTP endpoints called by the control plane
- **functions.py**: Modal function definitions (used internally)

### Scheduler (`src/scheduler/`)

- **image_builder.py**: Image rebuild infrastructure (scheduling currently disabled)

## Usage

> **Full deployment guide**: See [docs/GETTING_STARTED.md](../../docs/GETTING_STARTED.md) for complete setup
> instructions including all required secrets and configuration.

### Prerequisites

1. Install Modal CLI: `pip install modal`
2. Authenticate: `modal setup`
3. Create secrets via Modal CLI:

```bash
# LLM API keys
modal secret create llm-api-keys ANTHROPIC_API_KEY="sk-ant-..."

# GitHub App credentials (for GitHub repo access)
modal secret create github-app \
  GITHUB_APP_ID="123456" \
  GITHUB_APP_PRIVATE_KEY="$(cat private-key-pkcs8.pem)" \
  GITHUB_APP_INSTALLATION_ID="12345678"

# Bitbucket bot credentials (for Bitbucket clone access)
modal secret create bitbucket-bot \
  BITBUCKET_BOT_USERNAME="your-bot-username" \
  BITBUCKET_BOT_APP_PASSWORD="your-app-password"

# Internal API secret (for control plane authentication)
modal secret create internal-api \
  MODAL_API_SECRET="$(openssl rand -hex 32)" \
  ALLOWED_CONTROL_PLANE_HOSTS="your-control-plane.workers.dev"
```

See `.env.example` for a full list of environment variables.

### Deploy

```bash
# Deploy the app (recommended)
modal deploy deploy.py

# Alternative: deploy the src package directly
modal deploy -m src

# Run locally for development
modal run src/
```

> **Note**: Never deploy `src/app.py` directly - it only defines the app and shared resources.
> Use `deploy.py` or `-m src` to ensure all function modules are registered.

## HTTP API

The control plane communicates with Modal via HTTP endpoints. All endpoints (except health)
require HMAC authentication via the `Authorization` header.

Endpoint URLs follow the pattern: `https://{workspace}--open-inspect-{endpoint}.modal.run`

### Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `api-health` | GET | No | Health check |
| `api-create-sandbox` | POST | Yes | Create a new sandbox |
| `api-warm-sandbox` | POST | Yes | Pre-warm a sandbox |
| `api-snapshot` | GET | Yes | Get latest snapshot for a repo |
| `api-snapshot-sandbox` | POST | Yes | Take filesystem snapshot |
| `api-restore-sandbox` | POST | Yes | Restore sandbox from snapshot |

### Example: Create Sandbox

```bash
curl -X POST "https://${WORKSPACE}--open-inspect-api-create-sandbox.modal.run" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "session_id": "session-123",
    "repo_owner": "your-org",
    "repo_name": "your-repo",
    "control_plane_url": "https://your-control-plane.workers.dev",
    "sandbox_auth_token": "your-token"
  }'
```

### Example: Health Check

```bash
curl "https://${WORKSPACE}--open-inspect-api-health.modal.run"
# {"success": true, "data": {"status": "healthy", "service": "open-inspect-modal"}}
```

## Environment Variables

Set via Modal secrets:

| Variable | Secret | Description |
|----------|--------|-------------|
| `ANTHROPIC_API_KEY` | `llm-api-keys` | Anthropic API key for Claude |
| `GITHUB_APP_ID` | `github-app` | GitHub App ID for repo access |
| `GITHUB_APP_PRIVATE_KEY` | `github-app` | GitHub App private key (PKCS#8) |
| `GITHUB_APP_INSTALLATION_ID` | `github-app` | GitHub App installation ID |
| `MODAL_API_SECRET` | `internal-api` | Shared secret for control plane auth |
| `ALLOWED_CONTROL_PLANE_HOSTS` | `internal-api` | Comma-separated allowed hostnames for URL validation |
| `BITBUCKET_BOT_USERNAME` | `bitbucket-bot` | Bitbucket bot username for clone auth |
| `BITBUCKET_BOT_APP_PASSWORD` | `bitbucket-bot` | Bitbucket bot app password for clone auth |

## Verification Criteria

| Criterion | Test Method |
|-----------|-------------|
| App deploys successfully | `modal deploy deploy.py` completes without errors |
| Health endpoint responds | `curl https://{workspace}--open-inspect-api-health.modal.run` |
| Sandbox creation works | POST to `api-create-sandbox` returns success |
| Git sync completes | Verify HEAD matches origin after sandbox start |
| Snapshot/restore works | Take snapshot, restore, verify workspace state |

## Development

```bash
# Install dev dependencies
pip install -e ".[dev]"

# Run tests
pytest tests/

# Type check
mypy src/
```

### CLI Tools

Development utilities available via Modal CLI:

```bash
# Check service health
modal run src/cli.py::check_health

# List registered repositories
modal run src/cli.py::list_repos

# Register a repository (for testing)
modal run src/cli.py::register_repo --owner your-org --name your-repo
```
