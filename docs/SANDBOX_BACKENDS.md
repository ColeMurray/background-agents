# Sandbox Backend Configuration

Open-Inspect supports two sandbox backends for code execution:

1. **Modal** (default) - Uses Modal's container platform
2. **Cloudflare** - Uses Cloudflare's container platform (Sandbox SDK)

## Quick Start

Set the `sandbox_backend` variable in your Terraform configuration:

```hcl
# terraform.tfvars

# Modal (default)
sandbox_backend = "modal"

# OR Cloudflare
sandbox_backend = "cloudflare"
```

## Backend Comparison

| Feature                     | Modal              | Cloudflare              |
| --------------------------- | ------------------ | ----------------------- |
| **Snapshot/Restore**        | Yes                | No (planned)            |
| **Cold Start**              | ~10-30s            | ~5-15s                  |
| **Geographic Distribution** | US regions         | Global edge             |
| **Pricing Model**           | Per-second compute | Per-request + compute   |
| **Max Runtime**             | 2 hours            | Configurable            |
| **Auto-sleep**              | Manual timeout     | Built-in (`sleepAfter`) |
| **Terraform Support**       | Full               | Partial (see below)     |

## Modal Backend Setup

Modal is the default and original backend.

### 1. Modal Account & Configuration

1. Create a Modal account at https://modal.com
2. Install Modal CLI: `pip install modal`
3. Authenticate: `modal token new`
4. Note your workspace name (shown in Modal dashboard)

### 2. Terraform Configuration

In your `terraform.tfvars`:

```hcl
sandbox_backend = "modal"  # This is the default

# Modal credentials
modal_token_id     = "your-token-id"
modal_token_secret = "your-token-secret"
modal_workspace    = "your-workspace"
modal_api_secret   = "generate-with-openssl-rand-hex-32"
```

### 3. Deploy

```bash
cd terraform/environments/production
terraform apply
```

Terraform will:

1. Deploy the control plane Worker with Modal configuration
2. Deploy Modal infrastructure via the `modal-app` module

## Cloudflare Backend Setup

The Cloudflare backend uses the Cloudflare Sandbox SDK for container execution.

### 1. Prerequisites

- Cloudflare Workers account
- Access to Cloudflare Containers (may require enterprise or beta access)

### 2. Terraform Configuration

In your `terraform.tfvars`:

```hcl
sandbox_backend = "cloudflare"

# Anthropic API key (passed to sandbox containers)
anthropic_api_key = "your-anthropic-api-key"
```

### 3. Deploy

```bash
cd terraform/environments/production
terraform apply
```

Terraform will:

1. Generate `wrangler.jsonc` with container configuration
2. Deploy control plane with containers via `wrangler deploy`
3. Set all secrets via `wrangler secret put`

**Note**: The Cloudflare Terraform provider doesn't support containers, so we use the
`cloudflare-sandbox` module that shells out to wrangler CLI (similar to how Modal uses
`modal deploy`).

## Architecture Differences

### Modal Architecture

```
┌─────────────────┐     HTTP API      ┌─────────────────┐
│  Control Plane  │ ───────────────── │  Modal Service  │
│  (CF Worker)    │                   │                 │
│                 │ ◄──── WebSocket ──│  Python Bridge  │
│  SessionDO      │                   │       ↓         │
│                 │                   │    OpenCode     │
└─────────────────┘                   └─────────────────┘
```

- Control plane calls Modal HTTP API to create sandboxes
- Modal runs Python supervisor (`entrypoint.py`) and bridge (`bridge.py`)
- Bridge connects back to control plane via outbound WebSocket
- Supports snapshot/restore via Modal's filesystem snapshotting

### Cloudflare Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                  Control Plane Worker                        │
│                                                              │
│  ┌──────────────┐         ┌──────────────────────────────┐  │
│  │  SessionDO   │ ──────► │  Sandbox (Durable Object)    │  │
│  │              │         │  ┌────────────────────────┐  │  │
│  │  - Sessions  │ ◄────── │  │  Cloudflare Container  │  │  │
│  │  - Messages  │   WS    │  │                        │  │  │
│  │  - Events    │         │  │  supervisor.ts         │  │  │
│  │  - Prompts   │         │  │       ↓                │  │  │
│  └──────────────┘         │  │  bridge.ts ←→ OpenCode │  │  │
│                           │  └────────────────────────┘  │  │
│                           └──────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

- Sandbox is a Durable Object within the same Worker
- TypeScript supervisor (`supervisor.ts`) and bridge (`bridge.ts`)
- Same WebSocket-based communication pattern
- No snapshot support yet (fresh sandbox on restart)

## Switching Backends

To switch backends:

1. Update `sandbox_backend` in `terraform.tfvars`
2. Ensure backend-specific credentials are set
3. Run `terraform apply`

Note: Existing sessions may need to be restarted when switching backends.

## Troubleshooting

### Modal

- **"MODAL_API_SECRET not configured"**: Ensure `modal_api_secret` is set in terraform.tfvars
- **"MODAL_WORKSPACE not configured"**: Ensure `modal_workspace` is set in terraform.tfvars
- **Sandbox not connecting**: Check Modal logs with `modal app logs open-inspect`

### Cloudflare

- **"Sandbox binding not configured"**: Check that Terraform generated `wrangler.jsonc` correctly
- **wrangler deploy fails**: Ensure `wrangler` is installed (`npm install -g wrangler`)
- **Container build fails**: Check `packages/sandbox/Dockerfile` and build logs
- **Slow cold starts**: First request after sleep triggers container start (~5-15s)
