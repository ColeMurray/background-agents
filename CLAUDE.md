# Claude Code Project Notes

## Available Skills

- **`/onboarding`** - Interactive guided deployment of your own Open-Inspect instance. Walks through
  repository setup, credential collection, Terraform deployment, and verification with user handoffs
  as needed.

## Deploying Your Own Instance

For a complete guide to deploying your own instance of Open-Inspect, see
**[docs/GETTING_STARTED.md](docs/GETTING_STARTED.md)**.

Alternatively, run `/onboarding` for an interactive guided setup.

## Modal Infrastructure

### Deployment

**Never deploy `src/app.py` directly** - it only defines the app and shared resources, not the
functions.

Two valid deployment methods:

```bash
cd packages/modal-infra

# Method 1: Use deploy.py wrapper (recommended)
modal deploy deploy.py

# Method 2: Deploy the src package directly
modal deploy -m src
```

Both methods work because they import `src/__init__.py` which registers all function modules
(functions, web_api, scheduler) with the app.

**Common mistake**: Running `modal deploy src/app.py` will succeed but deploy nothing useful - no
endpoints will be created because `app.py` doesn't import the function modules.

### Web Endpoints

Web endpoints use the `@fastapi_endpoint` decorator and are exposed at:

```
https://{workspace}--{app}-{function_name}.modal.run
```

For example (replace `<workspace>` with your Modal workspace name):

- `api_create_sandbox` → `https://<workspace>--open-inspect-api-create-sandbox.modal.run`
- `api_health` → `https://<workspace>--open-inspect-api-health.modal.run`

Function names with underscores become hyphens in URLs.

### Secrets

Create Modal secrets via CLI:

```bash
modal secret create <secret-name> KEY1="value1" KEY2="value2"
```

Reference in code:

```python
my_secret = modal.Secret.from_name("secret-name", required_keys=["KEY1", "KEY2"])

@app.function(secrets=[my_secret])
def my_func():
    os.environ.get("KEY1")
```

### API Authentication

Modal HTTP endpoints require HMAC authentication from the control plane. This prevents unauthorized
access to sandbox creation, snapshot, and restore endpoints.

**Required secret**: `MODAL_API_SECRET` - A shared secret for HMAC-signed tokens.

The secret is managed via Terraform (`terraform/environments/production/`):

- Add `modal_api_secret` to your `.tfvars` file (generate with: `openssl rand -hex 32`)
- Terraform configures it for both services:
  - Control plane worker: `module.control_plane_worker.secrets`
  - Modal app: `module.modal_app.secrets` (as `internal-api` secret)

The control plane generates time-limited HMAC tokens that Modal endpoints verify. Tokens expire
after 5 minutes to prevent replay attacks.

### Image Builds

To force an image rebuild, update the `CACHE_BUSTER` variable in `src/images/base.py`:

```python
CACHE_BUSTER = "v24-description-of-change"
```

### Common Issues

1. **"modal-http: invalid function call"** - Usually means the function isn't registered with the
   app. Ensure:
   - The module is imported in `deploy.py`
   - You're deploying `deploy.py`, not just `app.py`

2. **Import errors with relative imports** - Modal runs code in a special context. Use the
   `deploy.py` pattern that adds `src` to sys.path.

3. **Pydantic dependency issues** - Use lazy imports inside functions to avoid loading pydantic at
   module import time:
   ```python
   @app.function()
   def my_func():
       from .sandbox.types import SessionConfig  # Lazy import
   ```

## GitHub App Authentication

> **Single-Tenant Design**: The GitHub App configuration uses a single installation ID
> (`GITHUB_APP_INSTALLATION_ID`) shared by all users. This means any user can access any repository
> the App is installed on. This system is designed for internal/single-tenant deployment only.

### Required Secrets

GitHub App credentials (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_INSTALLATION_ID`) are
needed by **two services**:

1. **Modal sandbox** - for cloning repos and pushing commits
2. **Control plane** - for listing installation repositories (`/repos` endpoint)

The Terraform configuration (`terraform/environments/production/main.tf`) passes these to both:

- `module.control_plane_worker.secrets` - for the `/repos` API endpoint
- `module.modal_app.secrets` - for git operations in sandboxes

If the control plane is missing these secrets, the `/repos` endpoint returns "GitHub App not
configured" and the web app's repository dropdown will be empty.

### Token Lifetime

- GitHub App installation tokens expire after **1 hour**
- Generate fresh tokens for operations that may happen after startup

### Key Format

- Cloudflare Workers require **PKCS#8** format for private keys
- Convert from PKCS#1:
  `openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in key.pem -out key-pkcs8.pem`

### Token Flow

```
Startup (git sync):  Modal → generate token → GITHUB_APP_TOKEN env var → sandbox
Push (PR creation):  Control plane → generate fresh token → WebSocket → sandbox
PR API:              Control plane → user OAuth token → GitHub API (server-side only)
```

## Control Plane (Cloudflare Workers)

### Deployment

The control plane is deployed via Terraform. See [terraform/README.md](terraform/README.md) for
details.

All secrets and environment variables are configured through Terraform's `terraform.tfvars` file.

### Durable Objects

Sessions use Durable Objects with SQLite storage. Key patterns:

- Hibernation support - WebSockets survive hibernation but in-memory state is lost
- Use `ctx.getWebSockets()` to recover WebSocket references after hibernation
- Store critical state in SQLite, not just memory

### D1 Database

The control plane uses a Cloudflare D1 database (`env.DB` binding) for three data categories:

**Session Index** (`sessions` table): Session metadata for listing and filtering. Managed by
`SessionIndexStore` in `src/db/session-index.ts`. Supports server-side filtering by status and
pagination via `limit`/`offset`.

**Repository Metadata** (`repo_metadata` table): Custom descriptions, aliases, channel associations,
and keywords per repo. Managed by `RepoMetadataStore` in `src/db/repo-metadata.ts`. Supports batch
fetching via `db.batch()`.

**Repo Secrets** (`repo_secrets` table): Encrypted repository-scoped secrets (AES-256-GCM using
`REPO_SECRETS_ENCRYPTION_KEY`). Managed by `RepoSecretsStore` in `src/db/repo-secrets.ts`.

**Repository list cache**: The `/repos` endpoint caches the enriched repository list in KV
(`REPOS_CACHE` binding) with a 5-minute TTL. KV is shared across isolates, so cache invalidation (on
metadata update) is consistent. On cache miss it re-fetches from GitHub and D1.

**API routes** (in `src/router.ts`):

- `GET /repos/:owner/:name/secrets` — list secret keys (values never exposed)
- `PUT /repos/:owner/:name/secrets` — upsert secrets (batch)
- `DELETE /repos/:owner/:name/secrets/:key` — delete a single secret

**Sandbox injection**: At spawn time, the lifecycle manager calls `getUserEnvVars()` on the session
DO, which decrypts secrets from D1 and passes them as environment variables. System variables
(`CONTROL_PLANE_URL`, `SANDBOX_AUTH_TOKEN`, etc.) always take precedence.

**Migrations**: D1 schema migrations live in `terraform/d1/migrations/` and are applied via
`scripts/d1-migrate.sh` during `terraform apply`.

**KV → D1 migration** (one-off): Run
`scripts/migrate-kv-to-d1.sh <kv-namespace-id> <d1-database-name>` to copy session and repo metadata
from the legacy `SESSION_INDEX` KV namespace to D1. Get the namespace ID from
`terraform output session_index_kv_id`. Requires `wrangler` auth and `jq`. Idempotent — safe to
re-run.

## Coding Conventions

### Durations and timeouts

- **Use seconds for Python, milliseconds for TypeScript.** These match the native conventions of
  each ecosystem (Modal's `timeout=` takes seconds; the control-plane uses `_MS` suffixes
  throughout). Never use minutes or hours as the unit — they force fractional values for common
  cases and require error-prone conversions at call sites.
- **Encode the unit in the name.** Python: `timeout_seconds`, `max_age_seconds`. TypeScript:
  `timeoutMs`, `INACTIVITY_TIMEOUT_MS`. A bare `timeout` with no unit suffix is ambiguous.
- **Define each default value exactly once.** Extract to a named constant
  (`DEFAULT_SANDBOX_TIMEOUT_SECONDS`) and import it everywhere. Never repeat a literal like `7200`
  across multiple files as a default — it will drift.
- **Don't restate literal values in comments.** Write `Defaults to DEFAULT_SANDBOX_TIMEOUT_SECONDS`
  instead of `Default: 7200`. Comments that echo a literal become silently wrong when the constant
  changes.

### Extending existing patterns

- When threading an existing field through new code paths, evaluate whether the existing design
  (naming, types, units) is correct — don't blindly propagate it. If the existing field has a bad
  unit or name, fix it in the same change rather than spreading the problem to more files.

## Testing

### End-to-End Test Flow

```bash
# Create session (replace <your-subdomain> with your Cloudflare Workers subdomain)
curl -X POST https://open-inspect-control-plane.<your-subdomain>.workers.dev/sessions \
  -H "Content-Type: application/json" \
  -d '{"repoOwner":"owner","repoName":"repo"}'

# Send prompt
curl -X POST https://.../sessions/{sessionId}/prompt \
  -H "Content-Type: application/json" \
  -d '{"content":"...","authorId":"test","source":"web"}'

# Check events
curl https://.../sessions/{sessionId}/events
```

### Viewing Logs

```bash
# Modal logs
modal app logs open-inspect

# Cloudflare logs (via dashboard)
# Go to Workers & Pages → Your Worker → Logs
```
