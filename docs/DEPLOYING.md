# Deploying Open-Inspect to Cloudflare

This guide covers how to deploy and update Open-Inspect on Cloudflare. Everything runs on
Cloudflare: the control plane (Workers + Durable Objects), sandboxes (Containers), and optionally
the web app (OpenNext on Workers).

For architecture details, see [HOW_IT_WORKS.md](./HOW_IT_WORKS.md).

---

## What Gets Deployed

| Component          | Platform                     | Deploy Method              | Config File                                    |
| ------------------ | ---------------------------- | -------------------------- | ---------------------------------------------- |
| Control plane      | Cloudflare Workers + DO      | `wrangler deploy`          | `packages/control-plane/wrangler.deploy.jsonc` |
| Sandbox container  | Cloudflare Containers        | Built by `wrangler deploy` | `Dockerfile.sandbox` (repo root)               |
| Web app (optional) | Vercel or Cloudflare Workers | Vercel auto-deploy or TF   | `packages/web/`                                |
| D1 migrations      | Cloudflare D1                | Terraform                  | `terraform/d1/migrations/`                     |
| Slack bot          | Cloudflare Workers           | Terraform                  | `packages/slack-bot/`                          |
| GitHub bot         | Cloudflare Workers           | Terraform                  | `packages/github-bot/`                         |

---

## Prerequisites

```bash
# Wrangler CLI (4.70+)
npm install -g wrangler

# Authenticate
wrangler login
```

---

## Deploying the Control Plane + Sandbox Container

The control plane and sandbox container are deployed together with a single `wrangler deploy`
command from the `packages/control-plane/` directory:

```bash
cd packages/control-plane
npx wrangler deploy -c wrangler.deploy.jsonc
```

This does three things:

1. **Builds and uploads the Worker** (TypeScript → bundled JS)
2. **Builds the sandbox Docker image** from `Dockerfile.sandbox` at the repo root
3. **Pushes the image** to Cloudflare's container registry and rolls out new containers

### What the deploy config controls

`packages/control-plane/wrangler.deploy.jsonc`:

```jsonc
{
  "name": "open-inspect-cp-jdunn",
  "main": "src/index.ts",

  // Sandbox container configuration
  "containers": [
    {
      "class_name": "Sandbox",
      "image": "../../Dockerfile.sandbox",  // relative to this file
      "instance_type": "standard-3",
      "max_instances": 5
    }
  ],

  // Durable Object bindings
  "durable_objects": {
    "bindings": [
      { "name": "SESSION", "class_name": "SessionDO" },
      { "name": "SCHEDULER", "class_name": "SchedulerDO" },
      { "name": "SANDBOX_CONTAINER", "class_name": "Sandbox" }
    ]
  },

  // DO migration history (append-only)
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["SessionDO", "SchedulerDO", "SandboxContainer"] },
    { "tag": "v2", "renamed_classes": [{ "from": "SandboxContainer", "to": "Sandbox" }] }
  ],

  // D1 + KV bindings
  "d1_databases": [{ "binding": "DB", ... }],
  "kv_namespaces": [{ "binding": "REPOS_CACHE", ... }],

  // Plain-text env vars (non-secret)
  "vars": {
    "DEPLOYMENT_NAME": "jdunn",
    "WORKER_URL": "https://open-inspect-cp-jdunn.telus.workers.dev"
  }
}
```

### Container rollout

After deploy, existing sandbox containers continue running the old image until they sleep or are
replaced. New sessions always get the latest image. To force a rollout, the Cloudflare runtime
restarts containers — you'll see
`"Runtime signalled the container to exit due to a new version rollout"` in logs. This typically
takes 1-3 minutes.

---

## Worker Secrets

Secrets are set once and persist across deploys. Set them from the `packages/control-plane/`
directory:

```bash
cd packages/control-plane

# LLM provider (Fuelix proxy)
echo "ak-your-fuelix-key" | npx wrangler secret put ANTHROPIC_API_KEY -c wrangler.deploy.jsonc
echo "https://api.fuelix.ai" | npx wrangler secret put ANTHROPIC_BASE_URL -c wrangler.deploy.jsonc

# GitHub App
echo "your-app-id" | npx wrangler secret put GITHUB_APP_ID -c wrangler.deploy.jsonc
echo "your-installation-id" | npx wrangler secret put GITHUB_APP_INSTALLATION_ID -c wrangler.deploy.jsonc
# For the private key (multiline):
npx wrangler secret put GITHUB_APP_PRIVATE_KEY -c wrangler.deploy.jsonc < /path/to/private-key.pem

# GitHub OAuth (for user login)
echo "your-client-id" | npx wrangler secret put GITHUB_CLIENT_ID -c wrangler.deploy.jsonc
echo "your-client-secret" | npx wrangler secret put GITHUB_CLIENT_SECRET -c wrangler.deploy.jsonc

# Encryption keys (generate once, never change)
echo "$(openssl rand -hex 32)" | npx wrangler secret put TOKEN_ENCRYPTION_KEY -c wrangler.deploy.jsonc
echo "$(openssl rand -hex 32)" | npx wrangler secret put REPO_SECRETS_ENCRYPTION_KEY -c wrangler.deploy.jsonc
```

List all secrets:

```bash
npx wrangler secret list -c wrangler.deploy.jsonc
```

---

## The Sandbox Docker Image

The sandbox image (`Dockerfile.sandbox` at repo root) is built from `cloudflare/sandbox:0.7.18` and
includes:

- Python 3.10, Node.js 22, pnpm, yarn, Bun
- OpenCode (`opencode-ai@latest`) + `@ai-sdk/openai-compatible`
- code-server (browser-based VS Code)
- agent-browser + Chromium
- GitHub CLI, ttyd (web terminal)
- The sandbox runtime (`packages/sandbox-runtime/`) — Python bridge + supervisor

The image is rebuilt on every `wrangler deploy` if any of these files change:

- `Dockerfile.sandbox`
- `packages/sandbox-runtime/` (Python bridge, entrypoint, types)

Cached layers are reused when unchanged — only modified layers rebuild.

### SDK version compatibility

The `@cloudflare/sandbox` npm package (in the control plane) must match the container base image
version. Both should be `0.7.18`:

- **SDK**: `packages/control-plane/package.json` → `"@cloudflare/sandbox": "0.7.18"`
- **Image**: `Dockerfile.sandbox` → `FROM docker.io/cloudflare/sandbox:0.7.18`

Version mismatches cause `setEnvVars()` to silently fail and produce hard-to-debug issues.

### Python 3.10 compatibility

The base image ships Python 3.10. The sandbox runtime must avoid Python 3.11+ features:

- `StrEnum` → use `(str, Enum)` backport (see `types.py`)
- `asyncio.timeout_at()` → use backport (see `bridge.py`)
- `"python"` binary → use `sys.executable` (only `python3` exists)

---

## LLM Provider Setup (Fuelix)

When `ANTHROPIC_BASE_URL` is set as a Worker secret, the sandbox supervisor configures OpenCode with
a custom Fuelix provider via `.opencode/opencode.json`:

```
Entrypoint detects ANTHROPIC_BASE_URL in env
  → Writes .opencode/opencode.json with Fuelix provider config
  → Runs `npm install @ai-sdk/openai-compatible` in workspace
  → Strips ANTHROPIC_API_KEY from OpenCode's env
  → Starts `opencode serve` (uses Fuelix provider from config)
```

The bridge remaps `anthropic/` model IDs to `fuelix/` so OpenCode uses the custom provider instead
of its built-in Anthropic provider (which hardcodes `x-api-key` auth).

To use a different LLM provider or direct Anthropic API, unset `ANTHROPIC_BASE_URL`:

```bash
npx wrangler secret delete ANTHROPIC_BASE_URL -c wrangler.deploy.jsonc
```

---

## Monitoring

### Live logs

```bash
cd packages/control-plane
npx wrangler tail -c wrangler.deploy.jsonc --format pretty
```

Key log messages during a sandbox spawn:

| Log                             | Meaning                                            |
| ------------------------------- | -------------------------------------------------- |
| `[sandbox] gitCheckout done`    | Repo cloned into container                         |
| `[sandbox] starting entrypoint` | Python supervisor launching                        |
| `Sandbox spawned`               | Control plane registered the sandbox               |
| `opencode.fuelix_provider`      | Fuelix config written to `.opencode/opencode.json` |
| `opencode.npm_install`          | `@ai-sdk/openai-compatible` installed in workspace |
| `ws.connect` (type=sandbox)     | Bridge connected via WebSocket                     |
| `sandbox_status: running`       | Sandbox ready for prompts                          |

### Common issues

| Symptom                                | Cause                                     | Fix                                              |
| -------------------------------------- | ----------------------------------------- | ------------------------------------------------ |
| Sandbox stuck at "connecting"          | Bridge can't connect back                 | Check `CONTROL_PLANE_URL` / `WORKER_URL`         |
| `StrEnum` / `asyncio.timeout_at` error | Python 3.11+ code in 3.10 container       | Use backports                                    |
| `invalid x-api-key`                    | Using Fuelix without `ANTHROPIC_BASE_URL` | Set the secret                                   |
| `Model not found: anthropic/...`       | OpenCode using built-in provider          | Ensure `.opencode/opencode.json` path is correct |
| Container keeps using old code         | Rollout not complete                      | Wait 2-3 min or create a new session             |

---

## Updating

### Code changes only (no Dockerfile changes)

```bash
cd packages/control-plane
npx wrangler deploy -c wrangler.deploy.jsonc
```

Worker updates instantly. Container image rebuilds but uses cached layers — deploys in ~30s.

### Sandbox runtime changes (Python bridge, entrypoint)

Same command — the `COPY packages/sandbox-runtime/` layer in the Dockerfile invalidates, triggering
a rebuild of that layer and everything after it. Deploy takes ~60s.

### Dockerfile changes (new system packages, new Node tools)

Same command — but earlier layers rebuild too. Deploy takes 2-5 min depending on which layer
changed.

### Shared package changes

Build shared first, then deploy:

```bash
npm run build -w @open-inspect/shared
cd packages/control-plane
npx wrangler deploy -c wrangler.deploy.jsonc
```
