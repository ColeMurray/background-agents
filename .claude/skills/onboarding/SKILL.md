---
name: onboarding
description:
  Deploy your own Open-Inspect instance. Use when the user wants to set up, deploy, or onboard to
  Open-Inspect. Guides through repository setup, credential collection, Terraform deployment, and
  verification with user handoffs.
user-invocable: true
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, AskUserQuestion, TodoWrite
---

# Open-Inspect Deployment Guide

You are guiding the user through deploying their own instance of Open-Inspect. This is a multi-phase
process requiring user interaction for credential collection and external service configuration.

## Before Starting

Use TodoWrite to create a checklist tracking these phases:

1. Initial setup questions
2. Repository setup
3. Credential collection (Cloudflare, Vercel, Modal, Anthropic)
4. GitHub App creation
5. Slack App creation (if enabled)
6. Security secrets generation
7. Terraform configuration
8. Terraform deployment (two phases)
9. Post-deployment Slack setup (if enabled)
10. Web app deployment
11. Verification
12. CI/CD setup (optional)

## Phase 1: Initial Questions

First, generate a random suffix suggestion for the user:

```bash
echo "Suggested deployment name: $(openssl rand -hex 3)"
```

Use AskUserQuestion to gather:

1. **Directory location** - Where to create the project (default: current directory or
   ~/workplace/open-inspect-{suffix})
2. **GitHub account** - Which account/org hosts the private repo
3. **Deployment name** - A globally unique identifier for URLs (e.g., their GitHub username, company
   name, or the random suffix generated above). Explain this creates URLs like
   `open-inspect-{deployment_name}.vercel.app` and must be unique across all Vercel users.
4. **Slack integration** - Yes or No
5. **Prerequisites confirmation** - Confirm they have accounts on Cloudflare, Vercel, Modal,
   Anthropic

## Phase 2: Repository Setup

Execute these commands (substitute values from Phase 1):

```bash
mkdir -p {directory_path}
gh repo create {github_account}/open-inspect-{name} --private --description "Open-Inspect deployment"
cd {directory_path}
git clone git@github.com:ColeMurray/open-inspect.git .
git remote rename origin upstream
git remote add origin git@github.com:{github_account}/open-inspect-{name}.git
git push -u origin main
npm install
npm run build -w @open-inspect/shared
```

## Phase 3: Credential Collection

Hand off to user for each service. Use AskUserQuestion to collect credentials.

### Cloudflare

Tell the user:

- **Account ID**: Found in dashboard URL or account overview
- **Workers Subdomain**: Workers & Pages → Overview, **bottom-right** panel shows
  `*.YOUR-SUBDOMAIN.workers.dev`
- **API Token**: Create at https://dash.cloudflare.com/profile/api-tokens with template "Edit
  Cloudflare Workers" + permissions for Workers KV Storage (Edit), Workers R2 Storage (Edit), D1
  (Edit)

### R2 Bucket

Check wrangler login status, then create bucket:

```bash
wrangler whoami
wrangler r2 bucket create open-inspect-{name}-tf-state
```

Tell user to create R2 API Token at R2 → Overview → Manage R2 API Tokens with "Object Read & Write"
permission.

### Vercel

- **API Token**: https://vercel.com/account/tokens
- **Team/Account ID**: Settings → "Your ID" (even personal accounts have one, usually starts with
  `team_`)

### Modal

- **Token ID and Secret**: https://modal.com/settings or `modal token new`
- **Workspace name**: Visible in Modal dashboard URL

Then set the token:

```bash
modal token set --token-id {token_id} --token-secret {token_secret}
modal profile current
```

### Anthropic

- **API Key**: https://console.anthropic.com (starts with `sk-ant-`)

## Phase 4: GitHub App Setup

Guide user through creating a GitHub App (handles both OAuth and repo access):

1. Go to https://github.com/settings/apps → "New GitHub App"
2. **Name**: `Open-Inspect-{YourName}` (globally unique)
3. **Homepage URL**: `https://open-inspect-{deployment_name}.vercel.app`
4. **Webhook**: Uncheck "Active"
5. **Callback URL** (under "Identifying and authorizing users"):
   `https://open-inspect-{deployment_name}.vercel.app/api/auth/callback/github`
   - **CRITICAL**: Must match deployed Vercel URL exactly!
6. **Repository permissions**: Contents (Read & Write), Pull requests (Read & Write), Metadata
   (Read-only)
7. Create app, note **App ID**
8. Generate **Client Secret**, note **Client ID** and **Client Secret**
9. Generate **Private Key** (downloads .pem file)
10. Install app on account, note **Installation ID** from URL

After receiving the .pem path, convert to PKCS#8:

```bash
openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in {pem_path} -out /tmp/github-app-key-pkcs8.pem
cat /tmp/github-app-key-pkcs8.pem
```

## Phase 5: Slack App Setup (If Enabled)

Guide user:

1. https://api.slack.com/apps → "Create New App" → "From scratch"
2. OAuth & Permissions → Add scopes: `app_mentions:read`, `chat:write`, `channels:history`,
   `channels:read`, `groups:history`, `groups:read`
3. Install to Workspace, note **Bot Token** (`xoxb-...`)
4. Basic Information → note **Signing Secret**
5. **App Home and Event Subscriptions configured AFTER deployment** (worker must be running for URL
   verification)

## Phase 6: Generate Security Secrets

```bash
echo "token_encryption_key: $(openssl rand -base64 32)"
echo "repo_secrets_encryption_key: $(openssl rand -base64 32)"
echo "internal_callback_secret: $(openssl rand -base64 32)"
echo "nextauth_secret: $(openssl rand -base64 32)"
echo "modal_api_secret: $(openssl rand -hex 32)"
```

## Phase 7: Terraform Configuration

Create `terraform/environments/production/backend.tfvars`:

```hcl
access_key = "{r2_access_key}"
secret_key = "{r2_secret_key}"
bucket     = "open-inspect-{name}-tf-state"
endpoints = {
  s3 = "https://{cloudflare_account_id}.r2.cloudflarestorage.com"
}
```

Create `terraform/environments/production/terraform.tfvars` with all collected values. Set:

```hcl
enable_durable_object_bindings = false
enable_service_bindings        = false
```

## Phase 8: Terraform Deployment (Two-Phase)

**Important**: Build the workers before running Terraform (Terraform references the built bundles):

```bash
npm run build -w @open-inspect/control-plane -w @open-inspect/slack-bot
```

**Phase 1** (bindings disabled):

```bash
cd terraform/environments/production
terraform init -backend-config=backend.tfvars
terraform apply
```

**Phase 2** (after Phase 1 succeeds): Update tfvars to set both bindings to `true`, then:

```bash
terraform apply
```

## Phase 9: Complete Slack Setup (If Enabled)

After Terraform deployment, guide user:

### Enable App Home

1. App Home → Show Tabs → Enable **"Home Tab"**
2. Save Changes

The App Home provides a settings interface where users can configure their preferred Claude model.

### Configure Event Subscriptions

1. Event Subscriptions → Enable → Request URL:
   `https://open-inspect-slack-bot-{deployment_name}.{subdomain}.workers.dev/events`
2. Wait for "Verified" checkmark
3. Subscribe to bot events: `app_home_opened`, `app_mention`

### Configure Interactivity

4. Interactivity → Enable → Request URL:
   `https://open-inspect-slack-bot-{deployment_name}.{subdomain}.workers.dev/interactions`

### Invite Bot to Channels

5. Invite bot to channels: `/invite @BotName`

## Phase 10: Web App Deployment

```bash
npx vercel link --project open-inspect-{deployment_name}
npx vercel --prod
```

## Phase 11: Verification

```bash
curl https://open-inspect-control-plane-{deployment_name}.{subdomain}.workers.dev/health
curl https://{workspace}--open-inspect-api-health.modal.run
curl -I https://open-inspect-{deployment_name}.vercel.app
```

Present deployment summary table. Instruct user to test: visit web app, sign in with GitHub, create
session, send prompt.

## Phase 12: CI/CD Setup (Optional)

Ask if user wants GitHub Actions CI/CD. If yes, use `gh secret set` for all required secrets.

## Error Handling

- **"redirect_uri is not associated"**: Callback URL mismatch - update GitHub App settings
- **Durable Object errors**: Must follow two-phase deployment
- **Slack bot not responding**: Check Event Subscriptions URL verified, bot invited to channel,
  reinstall if scopes changed
- **Vercel build fails**: Terraform configures the monorepo build commands automatically
- **"no such file or directory" for dist/index.js**: Build workers before Terraform:
  `npm run build -w @open-inspect/control-plane -w @open-inspect/slack-bot`
- **Worker deployment fails**: Build shared package first: `npm run build -w @open-inspect/shared`

## Important Notes

- Track all collected credentials securely throughout the process
- Never log sensitive values
- The callback URL MUST match the actual deployed Vercel URL
- Two-phase Terraform deployment is required due to Cloudflare Durable Object constraints
