# Open-Inspect Setup Guide

This is the primary setup guide for users and contributors.

It is organized by goal so you can pick the fastest path:

| Path   | Best For                                                 | Time       |
| ------ | -------------------------------------------------------- | ---------- |
| Path A | Run the web app locally against an existing backend      | ~10-20 min |
| Path B | Contribute code locally (lint/typecheck/tests)           | ~15-30 min |
| Path C | Deploy your own full stack (Cloudflare + Modal + Vercel) | ~1-3 hours |

## Important Context

Open-Inspect is designed for **single-tenant** use. Everyone in your deployment shares the same
GitHub App installation scope. Read the security model in [README.md](../README.md) before
production use.

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

- Terraform `1.6+`
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

Use this when you already have a deployed control plane and Modal backend, and only need local UI
development.

### 1. Create local env file

```bash
cp packages/web/.env.example packages/web/.env.local
```

### 2. Fill required variables

Edit `packages/web/.env.local`:

```bash
# GitHub App OAuth
GITHUB_CLIENT_ID=your_github_app_client_id
GITHUB_CLIENT_SECRET=your_github_app_client_secret

# NextAuth
NEXTAUTH_URL=http://localhost:3000
NEXTAUTH_SECRET=your_generated_secret

# Backend endpoints (deployed)
CONTROL_PLANE_URL=https://open-inspect-control-plane-<name>.<subdomain>.workers.dev
NEXT_PUBLIC_WS_URL=wss://open-inspect-control-plane-<name>.<subdomain>.workers.dev

# Must match control-plane INTERNAL_CALLBACK_SECRET
INTERNAL_CALLBACK_SECRET=your_shared_secret

# Optional access control
ALLOWED_USERS=
ALLOWED_EMAIL_DOMAINS=
```

Do not commit `packages/web/.env.local`.

Generate a secret value:

```bash
openssl rand -base64 32
```

If you are using someone else's deployed backend, do not generate your own
`INTERNAL_CALLBACK_SECRET`. Use the value configured in that backend deployment.

### 3. Configure GitHub callback URL

In GitHub App settings, include:

`http://localhost:3000/api/auth/callback/github`

If this does not match exactly, sign-in will fail.

### 4. Run the app

```bash
npm run dev -w @open-inspect/web
```

Open `http://localhost:3000`.

### 5. Verify it works

1. Sign in with GitHub.
2. Open or create a session.
3. Send a prompt.
4. Confirm live events stream in the session page.

If session actions fail, validate:

- `CONTROL_PLANE_URL`
- `NEXT_PUBLIC_WS_URL`
- `INTERNAL_CALLBACK_SECRET`

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

# preferred
uv sync --frozen --extra dev

# alternative
pip install -e ".[dev]"

pytest tests/ -v
```

## Path C: Full Self-Hosted Deployment

For full infrastructure setup, use:

- [docs/GETTING_STARTED.md](./GETTING_STARTED.md)

Critical notes before deploy:

- Build workers before running Terraform apply.
- Build `@open-inspect/shared` first.
- Use two-phase Terraform deploy for DO/service bindings.
- Deploy Modal with `modal deploy deploy.py` (not `src/app.py`).

## Common Issues and Fixes

### OAuth error: `redirect_uri is not associated with this application`

Your GitHub callback URL does not exactly match the running app URL.

### Access denied after sign-in

Check `ALLOWED_USERS` and `ALLOWED_EMAIL_DOMAINS` in `packages/web/.env.local`.

### Web can load, but session APIs return 401

`INTERNAL_CALLBACK_SECRET` in web env does not match the control plane secret.

### WebSocket disconnects immediately

For deployed control plane use `wss://...`, for local control plane use `ws://...`.

### Prompts queue but no sandbox work happens

Control plane cannot reach Modal (or Modal is not properly configured/deployed).

## Related Docs

- Architecture and internals: [docs/HOW_IT_WORKS.md](./HOW_IT_WORKS.md)
- Full production deployment: [docs/GETTING_STARTED.md](./GETTING_STARTED.md)
- Debugging and observability: [docs/DEBUGGING_PLAYBOOK.md](./DEBUGGING_PLAYBOOK.md)
- OpenAI model setup: [docs/OPENAI_MODELS.md](./OPENAI_MODELS.md)
- Contribution workflow: [CONTRIBUTING.md](../CONTRIBUTING.md)
