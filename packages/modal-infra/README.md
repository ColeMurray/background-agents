# Open-Inspect Modal Infrastructure

Modal-based sandbox infrastructure for the Open-Inspect coding agent system.

## Overview

This package provides the data plane for Open-Inspect:

- **Sandboxes**: Isolated development environments running OpenCode
- **Images**: Pre-built container images with all development tools
- **Snapshots**: Filesystem snapshots for fast startup and session persistence
- **Image builds**: Short-lived provider sessions that the control plane creates, starts, snapshots,
  and terminates

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
- Node.js 24, pnpm, Bun
- Python 3.12 with uv
- OpenCode CLI
- agent-browser CLI + headless Chrome

### Sandbox (`src/sandbox/`)

- **manager.py**: Sandbox lifecycle (create, restore, snapshot)
- **build_session.py**: Tagged build-sandbox lifecycle for prebuilt-image builds
- **vcs_env.py**: Clone-credential env-var injection

The in-sandbox runtime (entrypoint supervisor, control-plane bridge, shared types) lives in
`packages/sandbox-runtime`.

### Auth (`sandbox_runtime.auth`)

Provided by `packages/sandbox-runtime/src/sandbox_runtime/auth/`:

- **internal.py**: HMAC authentication for control plane requests

The control plane mints source-control credentials for image builds and snapshot restores.
Modal functions do not hold the GitHub App private key or mint installation tokens.

### API (`src/`)

- **web_api.py**: HTTP endpoints called by the control plane

Image rebuild evaluation and residual cleanup run in the provider-neutral
control-plane scheduler. Modal only owns its short-lived create, start,
snapshot, terminate, and delete provider operations.

## Usage

> **Full deployment guide**: See [docs/GETTING_STARTED.md](../../docs/GETTING_STARTED.md) for complete setup
> instructions including all required secrets and configuration.

### Prerequisites

1. Install Modal CLI: `pip install modal`
2. Authenticate: `modal setup`
3. Create secrets via Modal CLI:

```bash
# Fleet-wide LLM API keys. No key is required — pass an empty value to have
# sandboxes take their model credentials from the control plane's secret store
# instead. The secret itself must exist; Modal cannot hold one with no keys.
modal secret create llm-api-keys ANTHROPIC_API_KEY="sk-ant-..."

# Internal API secret (for control plane authentication)
modal secret create internal-api \
  MODAL_API_SECRET="$(openssl rand -hex 32)" \
  ALLOWED_CONTROL_PLANE_HOSTS="your-control-plane.workers.dev"
```

See `.env.example` for a full list of environment variables.

The legacy Modal `github-app` secret is optional and unused by the updated app; do not create it
for new deployments. The control plane's GitHub App credentials remain required for GitHub access.

### Install local packages

`sandbox-runtime` is a sibling package in this monorepo (not published to PyPI).
If you use `uv`, it is resolved automatically. Otherwise install it first:

```bash
pip install -e ../sandbox-runtime
pip install -e ".[dev]"
```

### Deploy

```bash
# Build the dynamic Sandbox image, then deploy the app (recommended)
uv run python deploy.py --build-sandbox-image
# Also build and verify the Docker-capable image variant (docs/MODAL_DOCKER.md):
# BUILD_MODAL_VM_IMAGE=true uv run python deploy.py --build-sandbox-image
uv run modal deploy deploy.py

# Alternative app deployment after the same eager image-build step
uv run modal deploy -m src

# Run locally for development
modal run src/
```

> **Note**: Never deploy `src/app.py` directly - it only defines the app and shared resources.
> Build the Sandbox image first, then use `deploy.py` or `-m src` to ensure all function modules
> are registered.

### Upgrade from Modal-side token minting

When the services can be deployed independently, updating the control plane first is preferred:
old Modal deployments ignore the new restore credential fields and keep minting tokens. Normal
Terraform upgrades instead deploy Modal first, because the control-plane Worker depends on
`module.modal_app`; `-target` cannot reverse this dependency. Updated Modal deployments do not mint
a fallback token when an old control plane omits it.

For normal Terraform upgrades, open a maintenance window before `terraform apply`: pause legacy
snapshot restores and avoid waking legacy sessions throughout the apply. Resume only after **both
Modal and the control plane deploy successfully**. If the Worker deployment fails, keep the
maintenance window open until it is fixed and deployed successfully. Helper-capable snapshots can
still request credentials on demand, but legacy restores must remain paused until both updates
succeed.

Delete the legacy Modal `github-app` secret only **after both deployments are updated** and any old
restore invocations have finished. Terraform no longer provisions it, but does not delete an
existing secret. Keep the control plane's GitHub App ID, private key, and installation ID configured.

## HTTP API

The control plane communicates with Modal via HTTP endpoints. All endpoints (except health)
require HMAC authentication via the `Authorization` header.

Endpoint URLs follow the pattern: `https://{workspace}--open-inspect-{endpoint}.modal.run`

### Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `api-health` | GET | No | Health check |
| `api-create-sandbox` | POST | Yes | Create a new sandbox |
| `api-snapshot-sandbox` | POST | Yes | Take filesystem snapshot |
| `api-restore-sandbox` | POST | Yes | Restore sandbox from snapshot |
| `api-create-build-sandbox` | POST | Yes | Create a dormant, tagged sandbox for a prebuilt-image build |
| `api-start-build-sandbox` | POST | Yes | Start the bound build runtime; results POST back to the control plane's `/image-builds/*` callbacks |
| `api-snapshot-build-sandbox` | POST | Yes | Snapshot the exact tagged build sandbox |
| `api-terminate-build-sandbox` | POST | Yes | Terminate the exact tagged build sandbox (idempotent when already absent) |

### Restore credentials

`api-restore-sandbox` accepts optional `clone_token`, `clone_host`, and `clone_username` strings
from the control plane, like `api-create-build-sandbox`. A provided host/username pair sets
`VCS_HOST` and `VCS_CLONE_USERNAME`; otherwise provider defaults apply. Modal does not resolve
credentials from its own environment.

Repository-backed restores still inject the supplied token as `VCS_CLONE_TOKEN` for snapshots
predating the git credential helper. For effective `VCS_HOST=github.com`, `GITHUB_TOKEN` and
`GITHUB_APP_TOKEN` aliases remain for snapshots predating the `gh` wrapper, without replacing a
user-supplied CLI token. Restores without a token are accepted; helper-capable snapshots fetch
credentials from the control plane.
Repository-less restores never inject the supplied clone token. Fresh and prebuilt-image session
boots continue to use only the credential helper.

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
| `ANTHROPIC_API_KEY` | `llm-api-keys` | Anthropic API key for Claude; may be empty when sessions use other providers |
| `MODAL_API_SECRET` | `internal-api` | Shared secret for control plane auth |
| `ALLOWED_CONTROL_PLANE_HOSTS` | `internal-api` | Comma-separated allowed hostnames for URL validation |

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
# Using uv (recommended — resolves sandbox-runtime automatically)
uv sync --frozen --extra dev

# Using pip (install sandbox-runtime first)
pip install -e ../sandbox-runtime
pip install -e ".[dev]"

# Run tests
pytest tests/

# Type check
mypy src/
```

### Health Check

The health endpoint is available at `GET /api_health` (no authentication required).
