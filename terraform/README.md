# Terraform Infrastructure

This directory contains Infrastructure as Code (IaC) for deploying the Open-Inspect system using
Terraform.

## Architecture Overview

The infrastructure spans multiple cloud providers:

| Provider       | Resources                                            | Terraform Support                   |
| -------------- | ---------------------------------------------------- | ----------------------------------- |
| **Cloudflare** | Workers, KV Namespaces, Durable Objects, D1 Database | Native provider                     |
| **Vercel**     | Next.js Web App, optional sandbox sessions           | Native provider + Sandbox API calls |
| **Modal**      | Optional sandbox infrastructure                      | CLI wrapper (no provider exists)    |
| **Daytona**    | Optional sandbox snapshots                           | REST API wrapper                    |

## Directory Structure

```
terraform/
├── d1/
│   └── migrations/              # D1 database migrations (applied via d1-migrate.sh)
├── modules/                      # Reusable Terraform modules
│   ├── cloudflare-kv/           # KV namespace management
│   ├── cloudflare-worker/       # Worker deployment with bindings (KV, DO, D1)
│   ├── daytona-infra/           # Daytona snapshot bootstrap wrapper
│   ├── vercel-project/          # Vercel project + environment vars
│   └── modal-app/               # Modal CLI wrapper
│       └── scripts/             # Deployment scripts
├── environments/
│   └── production/              # Production root module (split by concern)
│       ├── main.tf              # Entrypoint + file map
│       ├── locals.tf            # Shared naming/URL/script path locals
│       ├── kv.tf                # Cloudflare KV namespaces
│       ├── d1.tf                # D1 database + migrations
│       ├── workers-*.tf         # Worker builds/deployments per service
│       ├── web-*.tf             # Web app resources (Vercel/OpenNext)
│       ├── daytona.tf           # Daytona snapshot resources
│       ├── modal.tf             # Modal infrastructure
│       ├── checks.tf            # Terraform check blocks
│       ├── moved.tf             # State move declarations
│       ├── variables.tf         # Input variables
│       ├── outputs.tf           # Output values
│       ├── backend.tf           # State backend (R2)
│       ├── versions.tf          # Provider versions
│       └── terraform.tfvars.example
└── README.md                    # This file
```

## Prerequisites

### 1. Required Tools

```bash
# Terraform >= 1.9.0
brew install terraform

# Modal CLI (for Modal deployments)
pip install modal

# Node.js >= 22 (for building workers)
brew install node@22
```

### 2. Cloudflare Setup

1. **Create API Token** at [Cloudflare Dashboard](https://dash.cloudflare.com/profile/api-tokens)
   - Required account permissions:
     - Workers Scripts: **Edit**
     - Workers KV Storage: **Edit**
     - Workers R2 Storage: **Edit**
     - D1: **Edit**
     - Queues: **Edit** (required when the Slack bot is enabled)
   - If you manage Cloudflare routes/custom domains through Terraform, also add:
     - Workers Routes: **Edit**

2. **Create R2 Bucket** for Terraform state:
   - Bucket name: `open-inspect-terraform-state`
   - Generate R2 API token with read/write permissions

3. **Note your Account ID** (found in dashboard URL)

### 3. Vercel Setup

1. **Create API Token** at [Vercel Account Settings](https://vercel.com/account/tokens)
2. **Note your Team ID** (found in team settings URL)
3. If using `sandbox_provider = "vercel"`, also note the Project ID for the Vercel project that will
   own sandbox sessions.
4. Terraform builds an immutable Vercel base-runtime snapshot from the local checkout and passes a
   deterministic snapshot name into the control-plane Worker. `VERCEL_BASE_SNAPSHOT_ID` is only
   needed as a manual override.

### 4. Modal Setup

1. **Sign up** at [Modal](https://modal.com)
2. **Create API Token** at Modal Settings

### 5. GitHub Apps

1. **OAuth App** - For user authentication
   - Create at: https://github.com/settings/developers
   - Callback URL: `https://<your-vercel-app>.vercel.app/api/auth/callback/github`

2. **GitHub App** - For repository access in sandboxes
   - Create at: https://github.com/settings/apps
   - Convert private key to PKCS#8 format:
     ```bash
     openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in key.pem -out key-pkcs8.pem
     ```

### 6. Slack App

Create at [Slack API](https://api.slack.com/apps) and note:

- Bot OAuth Token (`xoxb-...`)
- Signing Secret

The bot token requires `app_mentions:read`, `chat:write`, `channels:history`, `channels:read`,
`groups:history`, `groups:read`, `im:history`, `im:read`, `files:read`, `files:write`, and
`reactions:write`. Reinstall the app after changing scopes.

When upgrading an existing Slack deployment, add **Queues: Edit** to the Cloudflare API token before
running `terraform apply`. Add `files:write` and `files:read`, reinstall the Slack app, and update
the deployed bot token if Slack issued a replacement before deploying this version.

## Quick Start

### 1. Configure Variables

```bash
cd terraform/environments/production

# Copy example files and fill in values
cp terraform.tfvars.example terraform.tfvars
cp backend.tfvars.example backend.tfvars

# Edit with your values
vim terraform.tfvars
vim backend.tfvars
```

### 2. Initialize Terraform

```bash
# Initialize with R2 backend config file
terraform init -backend-config=backend.tfvars

# Or pass values directly:
terraform init \
  -backend-config="access_key=YOUR_R2_ACCESS_KEY_ID" \
  -backend-config="secret_key=YOUR_R2_SECRET_ACCESS_KEY" \
  -backend-config='endpoints={s3="https://YOUR_ACCOUNT_ID.r2.cloudflarestorage.com"}'
```

### 3. Plan Changes

```bash
terraform plan
```

### 4. Apply Changes

```bash
terraform apply
```

## CI/CD Pipeline

The GitHub Actions workflow (`.github/workflows/terraform.yml`) automates:

| Trigger       | Action                           |
| ------------- | -------------------------------- |
| Pull Request  | `terraform plan` with PR comment |
| Merge to main | `terraform apply` (auto-approve) |

### Required GitHub Secrets

Add these secrets to your repository settings:

```
# Deployment
DEPLOYMENT_NAME          # Unique name for your deployment (e.g., 'acme', 'johndoe')

# Cloudflare
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_WORKER_SUBDOMAIN
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
WEB_PLATFORM # Optional; defaults to vercel

# Vercel web app (only if WEB_PLATFORM=vercel)
VERCEL_API_TOKEN
VERCEL_TEAM_ID
VERCEL_PROJECT_ID
NEXTAUTH_URL # Used by the Vercel web deploy workflow

# Modal
MODAL_TOKEN_ID
MODAL_TOKEN_SECRET
MODAL_WORKSPACE
MODAL_ENVIRONMENT # Optional; defaults to main
MODAL_ENVIRONMENT_WEB_SUFFIX # Optional; lowercase letters, digits, dashes; empty for workspace--... endpoints
MODAL_API_SECRET

# Sandbox provider
SANDBOX_PROVIDER

# Daytona (only if SANDBOX_PROVIDER=daytona)
DAYTONA_API_URL
DAYTONA_API_KEY
DAYTONA_BASE_SNAPSHOT
DAYTONA_TARGET # Optional

# Vercel Sandboxes (only if SANDBOX_PROVIDER=vercel)
VERCEL_SANDBOX_TOKEN
VERCEL_SANDBOX_PROJECT_ID
VERCEL_SANDBOX_TEAM_ID # Optional
VERCEL_BASE_SNAPSHOT_ID # Optional manual fallback; skips Terraform-managed snapshot builds
VERCEL_SANDBOX_RUNTIME # Optional; defaults to node24
VERCEL_SNAPSHOT_EXPIRATION_MS # Optional; defaults to 0
VERCEL_SANDBOX_API_BASE_URL # Optional advanced Vercel Sandbox API base URL override

# GitHub OAuth App
GH_OAUTH_CLIENT_ID
GH_OAUTH_CLIENT_SECRET

# GitHub App
GH_APP_ID
GH_APP_PRIVATE_KEY
GH_APP_INSTALLATION_ID

# Slack
ENABLE_SLACK_BOT # Optional; defaults to true
SLACK_BOT_TOKEN
SLACK_SIGNING_SECRET

# GitHub bot
ENABLE_GITHUB_BOT # Optional; defaults to false
GH_WEBHOOK_SECRET
GH_BOT_USERNAME

# Linear bot
ENABLE_LINEAR_BOT # Optional; defaults to false
LINEAR_CLIENT_ID
LINEAR_CLIENT_SECRET
LINEAR_WEBHOOK_SECRET

# API Keys
ANTHROPIC_API_KEY

# Security Secrets
TOKEN_ENCRYPTION_KEY
REPO_SECRETS_ENCRYPTION_KEY
INTERNAL_CALLBACK_SECRET
NEXTAUTH_SECRET

# Access control
ALLOWED_USERS
ALLOWED_EMAIL_DOMAINS
ENABLE_DURABLE_OBJECT_BINDINGS # Optional; defaults to true

# Branding
APP_NAME # Optional; defaults to Open-Inspect
APP_SHORT_NAME
APP_ICON_URL
```

## Module Reference

### cloudflare-kv

Creates a Cloudflare Workers KV namespace.

```hcl
module "my_kv" {
  source = "../../modules/cloudflare-kv"

  account_id     = var.cloudflare_account_id
  namespace_name = "my-namespace"
}
```

**Outputs:** `namespace_id`, `namespace_name`

### cloudflare-worker

Deploys a Cloudflare Worker with bindings using the native 3-resource pattern: `cloudflare_worker` +
`cloudflare_worker_version` + `cloudflare_workers_deployment`

```hcl
module "my_worker" {
  source = "../../modules/cloudflare-worker"

  account_id  = var.cloudflare_account_id
  worker_name = "my-worker"
  script_path = "dist/index.js"  # Path to bundled JS file

  kv_namespaces = [
    { binding_name = "KV", namespace_id = module.my_kv.namespace_id }
  ]

  service_bindings = [
    { binding_name = "OTHER_WORKER", service_name = "other-worker" }
  ]

  secrets = [
    { name = "API_KEY", value = var.api_key }
  ]

  durable_objects = [
    { binding_name = "DO", class_name = "MyDurableObject" }
  ]

  d1_databases = [
    { binding_name = "DB", database_id = cloudflare_d1_database.main.id }
  ]

  compatibility_date = "2024-09-23"
  migration_tag      = "v1"  # For DO migrations
}
```

**Outputs:** `worker_name`, `worker_id`, `version_id`, `deployment_id`, `worker_url`

### vercel-project

Creates a Vercel project with environment variables.

```hcl
module "web_app" {
  source = "../../modules/vercel-project"

  project_name = "my-app"
  team_id      = var.vercel_team_id
  framework    = "nextjs"

  git_repository = {
    type = "github"
    repo = "owner/repo"
  }

  root_directory = "packages/web"

  environment_variables = [
    {
      key       = "API_URL"
      value     = "https://api.example.com"
      targets   = ["production", "preview"]
      sensitive = false
    }
  ]
}
```

**Outputs:** `project_id`, `project_name`, `production_url`

### modal-app

Deploys a Modal app via CLI wrapper.

```hcl
module "modal" {
  source = "../../modules/modal-app"

  modal_token_id     = var.modal_token_id
  modal_token_secret = var.modal_token_secret

  app_name                     = "my-app"
  workspace                    = "my-workspace"
  modal_environment            = "main"
  modal_environment_web_suffix = ""
  deploy_path                  = "${path.root}/../../../packages/modal-infra"
  deploy_module                = "deploy"

  secrets = [
    {
      name = "my-secret"
      values = {
        KEY1 = "value1"
        KEY2 = "value2"
      }
    }
  ]
}
```

**Outputs:** `app_name`, `deploy_id`, `api_health_url`

## Important Notes

### Durable Objects

Durable Object migrations are applied with deployments. This means you can't bind to a Durable
Object in a Version if a deployment doesn't exist (i.e., migrations haven't been applied).

**First-time deployment with Durable Objects and service bindings:**

Use the built-in two-phase flags instead of editing Terraform modules:

1. Set `enable_durable_object_bindings = false` and `enable_service_bindings = false`.
2. Run `terraform apply` to create the initial workers and migrations.
3. Set both values back to `true`.
4. Run `terraform apply` again to attach the Durable Object and service bindings.

See
[Cloudflare's documentation](https://developers.cloudflare.com/workers/platform/infrastructure-as-code/)
for details.

### State Management

- State is stored in Cloudflare R2 (S3-compatible)
- Use state locking in production (consider DynamoDB or similar)
- Never commit `terraform.tfvars` or state files

### Modal Limitations

Since Modal has no Terraform provider, the module uses `null_resource` with `local-exec`:

- Changes are detected via source file hashing
- Manual intervention may be needed for complex updates

## Verification

After deployment, verify with:

```bash
# Get verification commands from Terraform output
terraform output verification_commands

# Or manually:

# 1. Health check control plane
curl https://open-inspect-control-plane-prod.<subdomain>.workers.dev/health

# 2. Sandbox backend health check
# Modal exposes a health endpoint. Prefer the exact URL from terraform output verification_commands.
# Manual form: https://<workspace>[-<modal_environment_web_suffix>]--open-inspect-api-health.modal.run
MODAL_WORKSPACE_SLUG="<workspace>" # or "<workspace>-<modal_environment_web_suffix>"
curl https://${MODAL_WORKSPACE_SLUG}--open-inspect-api-health.modal.run
# Daytona and Vercel use their provider APIs directly, so there is no Open-Inspect shim health URL.

# 3. Verify Vercel deployment (replace with your Vercel app URL)
curl https://<your-vercel-app>.vercel.app

# 4. Test authenticated endpoint (should return 401)
curl https://open-inspect-control-plane-prod.<subdomain>.workers.dev/sessions
```

## Troubleshooting

### "Backend initialization required"

```bash
terraform init \
  -backend-config="access_key=$R2_ACCESS_KEY_ID" \
  -backend-config="secret_key=$R2_SECRET_ACCESS_KEY"
```

### "Provider configuration not present"

Ensure all required variables are set either in `terraform.tfvars` or as `TF_VAR_*` environment
variables.

### Modal deployment fails

1. Check Modal CLI is installed: `modal --version`
2. Verify Modal credentials: `modal token show`
3. Check logs: `modal app logs open-inspect`

### Worker deployment fails

1. Build workers first: `npm run build -w @open-inspect/control-plane`
2. Check script exists: `ls packages/control-plane/dist/index.js`
3. Verify Cloudflare API token permissions:
   - `Workers Scripts: Edit`
   - `Workers KV Storage: Edit`
   - `Workers R2 Storage: Edit`
   - `D1: Edit`
   - `Queues: Edit` if the Slack bot is enabled
   - `Workers Routes: Edit` if you manage routes/custom domains through Terraform

## Adding New Environments

To add a staging environment:

```bash
# Copy production config
cp -r environments/production environments/staging

# Update backend key in staging/backend.tf
# key = "staging/terraform.tfstate"

# Update environment variable in staging/terraform.tfvars
# environment = "staging"

# Initialize and apply
cd environments/staging
terraform init -backend-config="access_key=..." -backend-config="secret_key=..."
terraform apply
```

## Security Considerations

- All sensitive variables are marked with `sensitive = true`
- Never commit `terraform.tfvars` files
- Use GitHub Secrets for CI/CD
- Rotate secrets regularly
- Review plan output before applying
