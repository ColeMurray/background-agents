# AGENTS.md

Open-Inspect is a background coding agent system that spawns sandboxed dev environments to work on
GitHub repositories. Single-tenant design. Stack: Cloudflare Workers (TypeScript), Modal (Python),
Next.js (React), Terraform.

## Architecture

Three tiers connected by WebSockets:

1. **Web Client** (Next.js on Vercel or Cloudflare Workers via OpenNext) — UI with GitHub OAuth,
   session dashboard, real-time streaming
2. **Control Plane** (Cloudflare Workers + Durable Objects) — session lifecycle, WebSocket hub,
   GitHub/auth integration. Each session is a Durable Object with SQLite storage. Uses D1 for
   session index, repo metadata, and encrypted repo secrets.
3. **Data Plane** (Modal, Python) — sandboxed environments running coding agents. Manages sandbox
   creation, warm pools, snapshots.

**Bot integrations** — all Cloudflare Workers using Hono:

- `slack-bot` — Slack messages → coding sessions
- `github-bot` — PR review assignments and @mention commands
- `linear-bot` — Linear agent webhooks → coding sessions

**Data flow**: User prompt → web client → control plane DO (WebSocket) → Modal sandbox → streaming
events back through the same WebSocket chain.

### Package Dependency Graph

```
@open-inspect/shared  ←  control-plane, web, slack-bot, github-bot, linear-bot
```

**Build `@open-inspect/shared` first** whenever you change shared types. Other packages import from
it at build time.

## Package Overview

| Package         | Lang / Framework                   | Purpose                                                     |
| --------------- | ---------------------------------- | ----------------------------------------------------------- |
| `shared`        | TypeScript                         | Shared types, auth utilities, model definitions             |
| `control-plane` | TypeScript / CF Workers + DO       | Session management, WebSocket streaming, GitHub integration |
| `web`           | TypeScript / Next.js 16 + React 19 | User-facing dashboard, OAuth, real-time UI                  |
| `slack-bot`     | TypeScript / CF Workers + Hono     | Slack event handler, session creation                       |
| `github-bot`    | TypeScript / CF Workers + Hono     | PR review and @mention webhook handler                      |
| `linear-bot`    | TypeScript / CF Workers + Hono     | Linear agent webhook handler                                |
| `modal-infra`   | Python 3.12 / Modal + FastAPI      | Sandbox lifecycle, WebSocket bridge to control plane        |

## Common Commands

```bash
# Install & build
npm install
npm run build                                    # all packages
npm run build -w @open-inspect/shared            # shared only (build first!)

# Lint & format
npm run lint:fix                                 # ESLint + Prettier fix
npm run format                                   # Prettier only
npm run typecheck                                # tsc across all TS packages

# Tests — TypeScript (Vitest)
npm test -w @open-inspect/control-plane          # unit tests (node env)
npm run test:integration -w @open-inspect/control-plane  # integration (workerd/Miniflare + real D1)
npm test -w @open-inspect/web
npm test -w @open-inspect/github-bot
npm test -w @open-inspect/slack-bot
npm test -w @open-inspect/linear-bot

# Tests — Python (pytest)
cd packages/modal-infra && pytest tests/ -v

# Python linting
cd packages/modal-infra && ruff check --fix && ruff format
```

## Testing

All TypeScript packages use **Vitest**; Python uses **pytest** + pytest-asyncio.

### Test file locations

- **control-plane unit**: co-located as `src/**/*.test.ts` — run in Node environment
- **control-plane integration**: separate `test/integration/*.test.ts` — run in workerd via
  `@cloudflare/vitest-pool-workers` with real D1 bindings
- **web, slack-bot, linear-bot**: co-located `src/**/*.test.ts`
- **github-bot**: separate `test/*.test.ts`
- **modal-infra**: `tests/test_*.py`

### Control-plane integration tests

These run inside a real `workerd` runtime with Miniflare, using `defineWorkersConfig`. Important:

- `isolatedStorage: false` due to a workers-sdk SQLite WAL cleanup bug — tests share storage
- Use `cleanD1Tables()` or equivalent cleanup in `beforeEach` to avoid cross-test pollution
- D1 migrations from `terraform/d1/migrations/` are applied automatically via
  `test/integration/apply-migrations.ts`
- Helpers in `test/integration/helpers.ts`: `initSession()`, `queryDO()`, `seedEvents()`

## Coding Conventions

### Durations and timeouts

- **Use seconds for Python, milliseconds for TypeScript.** These match each ecosystem's conventions
  (Modal `timeout=` takes seconds; control-plane uses `_MS` suffixes throughout).
- **Encode the unit in the name.** Python: `timeout_seconds`. TypeScript: `timeoutMs`,
  `INACTIVITY_TIMEOUT_MS`. Never use a bare `timeout`.
- **Define each default value exactly once.** Extract to a named constant and import everywhere.
- **Don't restate literal values in comments.** Write `Defaults to DEFAULT_SANDBOX_TIMEOUT_SECONDS`,
  not `Default: 7200`.

### Extending existing patterns

- When threading an existing field through new code paths, evaluate whether the existing design
  (naming, types, units) is correct — don't blindly propagate it. Fix bad names or units in the same
  change rather than spreading the problem.

### Commit messages

Use conventional commits: `feat:`, `fix:`, `docs:`, `refactor:`, `chore:`, `test:`. Keep the subject
under 72 characters. Use the PR body for details, not the commit message.

## Key Gotchas

- **Build order**: always build `@open-inspect/shared` before packages that depend on it.
- **PKCS#8 keys**: Cloudflare Workers require PKCS#8 format for GitHub App private keys — convert
  with `openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt`.
- **Durable Object bindings**: new DO bindings require a two-phase Terraform deploy — first with
  `enable_durable_object_bindings = false`, then `true`.
- **No `wrangler.toml`**: control-plane config is generated by Terraform, not checked in.
- **Modal deployment**: never deploy `src/app.py` directly — use `modal deploy deploy.py` or
  `modal deploy -m src`. The `app.py` file doesn't import function modules.
- **Modal image rebuild**: update `CACHE_BUSTER` in `src/images/base.py` to force a rebuild.
- **Web platform choice**: set `web_platform = "cloudflare"` in Terraform variables to deploy the
  web app to Cloudflare Workers via OpenNext instead of Vercel. When using Cloudflare, Vercel
  credentials are not required (dummy defaults are used). `NEXT_PUBLIC_WS_URL` must be available at
  build time since Next.js inlines `NEXT_PUBLIC_*` vars into the client bundle.

## CI/CD

Pushing to `main` auto-deploys changed services:

- **Terraform** → control plane + D1 migrations + web app if `web_platform = "cloudflare"`
  (triggers: `terraform/`, `packages/*/`)
- **Vercel** → web app when `web_platform = "vercel"` (triggers: `packages/web/`,
  `packages/shared/`)
- **Modal** → data plane (triggers: `packages/modal-infra/`, deployed via Terraform apply)

CI runs lint, typecheck, and tests for all TypeScript and Python packages on every push and PR.

## Further Reading

- [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md) — deploy your own instance
- [docs/HOW_IT_WORKS.md](docs/HOW_IT_WORKS.md) — detailed architecture and session lifecycle
- [CONTRIBUTING.md](CONTRIBUTING.md) — contribution guidelines
- [packages/control-plane/README.md](packages/control-plane/README.md) — API reference, WebSocket
  protocol, D1 schema, security model
- [packages/modal-infra/README.md](packages/modal-infra/README.md) — sandbox internals, Modal
  deployment, endpoint URLs
