# Open-Inspect Setup Guide

This is the primary setup guide for users and contributors.

It is organized by goal so you can pick the fastest path:

| Path   | Best For                                            | Time       |
| ------ | --------------------------------------------------- | ---------- |
| Path A | Run the web app locally against an existing backend | ~10-20 min |
| Path B | Contribute code locally (lint/typecheck/tests)      | ~15-30 min |
| Path C | Deploy your own full stack                          | ~1-3 hours |

## Important Context

Open-Inspect is designed for **single-tenant** use. Everyone in your deployment shares the same
GitHub App installation scope. Read the security model in [README.md](../README.md) before
production use.

The control plane is the sole sign-in-provider authority. GitHub-only, Google-only, and combined
sign-in are supported, while GitHub App repository credentials remain required for all three.

## Prerequisites

Required:

- Node.js `22+` (minimum supported: `20+`)
- npm
- Git

Optional (needed for `modal-infra` development):

- Python `3.12+`
- `uv` (recommended) or `pip`
- Modal CLI (`modal`)

Optional (needed for full deployment):

- Terraform `1.9+`
- Wrangler CLI

Quick check:

```bash
node -v
npm -v
git --version
```

## Step 0: Bootstrap the Repo

From repository root:

```bash
bash .openinspect/setup.sh
```

What this does:

- installs JS dependencies
- builds `@open-inspect/shared`
- installs git hooks
- sets up Python env for `packages/modal-infra` when possible

## Path A: Run the Web App Locally (Recommended Quick Start)

Use this with a dedicated development control plane whose `WEB_APP_URL` is `http://localhost:3000`.
Browser auth is origin-bound, so a production control plane configured for its deployed web origin
cannot authenticate a localhost web process.

### 1. Create local env file

```bash
cp packages/web/.env.example packages/web/.env.local
```

### 2. Fill required variables

Edit `packages/web/.env.local`:

```bash
# Development control-plane endpoints
CONTROL_PLANE_URL=https://open-inspect-control-plane-<name>.<subdomain>.workers.dev
NEXT_PUBLIC_WS_URL=wss://open-inspect-control-plane-<name>.<subdomain>.workers.dev

# Web's per-service signing secret. Must match the control plane's
# SERVICE_AUTH_SECRET_WEB binding (Terraform generates it; read it from
# terraform state or the deployed web app's env).
SERVICE_AUTH_SECRET=your_web_service_secret

# Optional whitelabel branding (defaults shown). NEXT_PUBLIC_* vars are
# inlined into the client bundle at build time — restart `npm run dev`
# after changing them.
NEXT_PUBLIC_APP_NAME=Open-Inspect
NEXT_PUBLIC_APP_ICON_URL=
```

Do not commit `packages/web/.env.local`.

OAuth provider credentials are not web environment variables. Better Auth runs in the control plane,
so configure at least one complete pair: `github_client_id` plus `github_client_secret`,
`google_client_id` plus `google_client_secret`, or both. See
[Create GitHub App](GETTING_STARTED.md#step-3-create-github-app) and
[Enable Google Login](GETTING_STARTED.md#enable-google-login-optional) for the complete provider
setup. The `/login` page reads the enabled provider set from the control plane at request time.

If you are using someone else's deployed backend, do not generate your own `SERVICE_AUTH_SECRET`.
Use the web service secret configured in that backend deployment (the control plane only accepts
signatures under its own copy). That backend must also be configured with
`WEB_APP_URL=http://localhost:3000`; otherwise use its deployed web app rather than a local UI.

### 3. Configure OAuth callback URLs

If GitHub sign-in is enabled, include this callback in the GitHub App settings:

`http://localhost:3000/api/auth/callback/github`

If this does not match exactly, sign-in will fail.

If you enabled Google login, also add this redirect URI to your Google OAuth client:

`http://localhost:3000/api/auth/callback/google`

### 4. Run the app

```bash
npm run dev -w @open-inspect/web
```

Open `http://localhost:3000`.

### 5. Verify it works

1. Sign in with each configured provider.
2. Open or create a session.
3. Send a prompt.
4. Confirm live events stream in the session page.

If session actions fail, validate:

- `CONTROL_PLANE_URL`
- `NEXT_PUBLIC_WS_URL`
- `SERVICE_AUTH_SECRET`

These must align with your deployed backend.

## Path B: Contributor Local Workflow

Use this for day-to-day engineering work in the monorepo.

### JavaScript/TypeScript workflow

```bash
# Build shared first if it changed
npm run build -w @open-inspect/shared

# Monorepo checks
npm run lint
npm run typecheck
npm test
```

### Targeted test commands

```bash
# Control plane
npm test -w @open-inspect/control-plane
npm run test:integration -w @open-inspect/control-plane

# Web
npm test -w @open-inspect/web

# Bots
npm test -w @open-inspect/github-bot
npm test -w @open-inspect/slack-bot
npm test -w @open-inspect/linear-bot
```

### Python (`modal-infra`) workflow

```bash
cd packages/modal-infra

# preferred (sandbox-runtime resolved automatically via uv.lock)
uv sync --frozen --extra dev

# alternative (install sandbox-runtime sibling package first)
pip install -e ../sandbox-runtime
pip install -e ".[dev]"

pytest tests/ -v
```

## Path C: Full Self-Hosted Deployment

Follow the full deployment guide and generate `token_encryption_key` and
`repo_secrets_encryption_key`. Terraform generates and persists the independent provider-account
credential key unless an existing `provider_accounts_encryption_key` override is supplied. After
deployment, connect subscriptions in **Settings > Provider Accounts**, configure defaults and
unattended modes, and rebuild every runtime image. Legacy scoped OAuth can coexist with provider
accounts; defaults affect only sessions created afterward.

For full infrastructure setup, use:

- [docs/GETTING_STARTED.md](./GETTING_STARTED.md)

Critical notes before deploy:

- Build workers before running Terraform apply.
- Build `@open-inspect/shared` first.
- Use two-phase Terraform deploy for DO/service bindings.
- For Modal deployments, eagerly build the Sandbox image with
  `uv run python deploy.py --build-sandbox-image`, then deploy with `uv run modal deploy deploy.py`
  (not `src/app.py`).
- Existing sessions keep their pinned authentication. Remove legacy OAuth keys only after dependent
  legacy-bound sessions are no longer needed.

## Common Issues and Fixes

### OAuth error: `redirect_uri is not associated with this application`

Your GitHub callback URL does not exactly match the running app URL.

### Access denied after sign-in

Check `allowed_users`, `allowed_email_domains`, `allowed_emails`, and `allowed_github_orgs` in the
control plane's Terraform configuration. If `allowed_github_orgs` is set, make sure your GitHub App
has Organization permissions: Members read-only and that the updated permission was republished and
approved for the installation.

### Web can load, but session APIs return 401

`SERVICE_AUTH_SECRET` in web env does not match the control plane's `SERVICE_AUTH_SECRET_WEB`
binding.

### WebSocket disconnects immediately

For deployed control plane use `wss://...`, for local control plane use `ws://...`.

### Prompts queue but no sandbox work happens

The control plane cannot reach the configured sandbox backend, or that backend is not properly
configured/deployed.

## Related Docs

- Architecture and internals: [docs/HOW_IT_WORKS.md](./HOW_IT_WORKS.md)
- Full production deployment: [docs/GETTING_STARTED.md](./GETTING_STARTED.md)
- Control plane in a container (no Cloudflare):
  [docs/CONTROL_PLANE_CONTAINER.md](./CONTROL_PLANE_CONTAINER.md)
- GitHub integration usage: [docs/integrations/GITHUB.md](./integrations/GITHUB.md)
- Linear integration usage: [docs/integrations/LINEAR.md](./integrations/LINEAR.md)
- Debugging and observability: [docs/DEBUGGING_PLAYBOOK.md](./DEBUGGING_PLAYBOOK.md)
- Available models: [docs/AVAILABLE_MODELS.md](./AVAILABLE_MODELS.md)
- Managed skills: [docs/MANAGED_SKILLS.md](./MANAGED_SKILLS.md)
- OpenAI model setup: [docs/OPENAI_MODELS.md](./OPENAI_MODELS.md)
- SuperGrok model setup: [docs/GROK_MODELS.md](./GROK_MODELS.md)
- Contribution workflow: [CONTRIBUTING.md](../CONTRIBUTING.md)
