# Getting Started with Open-Inspect

This guide walks you through deploying your own instance of Open-Inspect using Terraform.

> **Important**: This system is designed for **single-tenant deployment only**. All users share the
> same GitHub App credentials and can access any repository the App is installed on. See the
> [Security Model](../README.md#security-model-single-tenant-only) for details.

---

## Overview

Open-Inspect uses Terraform to automate deployment across three cloud providers:

| Provider       | Purpose                          | What Terraform Creates                               |
| -------------- | -------------------------------- | ---------------------------------------------------- |
| **Cloudflare** | Control plane, session state     | Workers, KV namespaces, Durable Objects, D1 Database |
| **Vercel**     | Web application                  | Project, environment variables                       |
| **Modal**      | Sandbox execution infrastructure | App deployment, secrets, volumes                     |

**Your job**: Create accounts, gather credentials, and configure one file (`terraform.tfvars`).
**Terraform's job**: Create all infrastructure and configure services.

---

## Prerequisites

### Required Accounts

Create accounts on these services before continuing:

| Service                                          | Purpose                   |
| ------------------------------------------------ | ------------------------- |
| [Cloudflare](https://dash.cloudflare.com)        | Control plane hosting     |
| [Vercel](https://vercel.com)                     | Web application hosting   |
| [Modal](https://modal.com)                       | Sandbox infrastructure    |
| [GitHub](https://github.com/settings/developers) | OAuth + repository access |
| [Anthropic](https://console.anthropic.com)       | Claude API                |
| [Slack](https://api.slack.com/apps) _(optional)_ | Slack bot integration     |
| GitHub App Webhooks _(optional)_                 | GitHub bot (PR reviews)   |

### Required Tools

```bash
# Terraform (1.6.0+)
brew install terraform

# Node.js (22+)
brew install node@22

# Python 3.12+ and Modal CLI
pipx install modal
modal setup

# Wrangler CLI (for initial R2 bucket setup)
npm install -g wrangler
```

---

## Step 1: Fork the Repository

Fork [ColeMurray/background-agents](https://github.com/ColeMurray/background-agents) to your GitHub
account or organization.

```bash
# Clone your fork
git clone https://github.com/YOUR-USERNAME/background-agents.git
cd background-agents
npm install

# Build the shared package (required before Terraform deployment)
npm run build -w @open-inspect/shared
```

---

> **Tip**: Before proceeding, copy `terraform/environments/production/terraform.tfvars.example` to
> `terraform.tfvars` and keep it open. As you collect credentials in the following steps, paste them
> directly into this file.

---

## Step 2: Create Cloud Provider Credentials

### Cloudflare

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com)
2. **Note your Account ID** (visible in the dashboard URL or account overview)
3. **Note your Workers subdomain**: Go to Workers & Pages → Overview, look in the **bottom-right**
   of the panel for `*.YOUR-SUBDOMAIN.workers.dev`
4. **Create API Token** at [API Tokens](https://dash.cloudflare.com/profile/api-tokens):
   - Use template: "Edit Cloudflare Workers"
   - Add permissions: Workers KV Storage (Edit), Workers R2 Storage (Edit)
5. **Enable R2**: Must add payment info, but first 10 GB/month is free

### Cloudflare R2 (Terraform State Backend)

Terraform needs a place to store its state. We use Cloudflare R2.

```bash
# Login to Cloudflare
wrangler login


# Create the state bucket
wrangler r2 bucket create open-inspect-terraform-state
```

Create an R2 API Token:

1. Go to R2 → Overview → Manage R2 API Tokens
2. Create token with **Object Read & Write** permission
3. Note the **Access Key ID** and **Secret Access Key**

### Vercel

1. Go to [Vercel Account Settings → Tokens](https://vercel.com/account/tokens)
2. Create a new token with full access
3. **Note your Team/Account ID**:
   - Go to **Settings** (Account Settings or Team Settings)
   - Look for **"Your ID"** or find it in the URL: `vercel.com/{YOUR_TEAM_ID}/...`
   - Even personal accounts have an ID (usually starts with `team_`)

### Modal

1. Go to [Modal Settings](https://modal.com/settings)
2. **Create a new API token**: Settings -> API Tokens -> New Token
3. Note the **Token ID** and **Token Secret**
4. Note your **Workspace name** (visible in your Modal dashboard URL)

### Anthropic

1. Go to [Anthropic Console](https://console.anthropic.com)
2. Create an API key
3. Note the **API Key** (starts with `sk-ant-`)

> **Want to use your OpenAI ChatGPT subscription?** See [Using OpenAI Models](OPENAI_MODELS.md) for
> setup instructions (can be configured after deployment).

---

## Step 3: Create GitHub App

You only need **one GitHub App** - it handles both user authentication (OAuth) and repository
access.

1. Go to [GitHub Apps](https://github.com/settings/apps)
2. Click **"New GitHub App"**
3. Fill in the basics:
   - **Name**: `Open-Inspect-YourName` (must be globally unique)
   - **Homepage URL**: `https://open-inspect-{your-deployment-name}.vercel.app` (or your custom
     domain)
   - **Webhook**: Uncheck "Active" (not needed)
4. Configure **Identifying and authorizing users** (OAuth):
   - **Callback URL**:
     `https://open-inspect-{your-deployment-name}.vercel.app/api/auth/callback/github`

   > **Important**: The callback URL must match your deployed Vercel URL exactly. Terraform creates
   > `https://open-inspect-{deployment_name}.vercel.app` where `{deployment_name}` is the unique
   > value you set in `terraform.tfvars` (e.g., your GitHub username or company name).

5. Set **Repository permissions**:
   - Contents: **Read & Write**
   - Issues: **Read & Write** _(required if enabling GitHub bot)_
   - Pull requests: **Read & Write**
   - Metadata: **Read-only**
6. Click **"Create GitHub App"**
7. Note the **App ID** and **Client ID** (top of page)
8. Under **"Client secrets"**, click **"Generate a new client secret"** and note the **Client
   Secret**
9. Scroll down to **"Private keys"** and click **"Generate a private key"** (downloads a .pem file)
10. **Convert the key to PKCS#8 format** (required for Cloudflare Workers):
    ```bash
    openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt \
      -in ~/Downloads/your-app-name.*.private-key.pem \
      -out private-key-pkcs8.pem
    ```
11. **Install the app** on your account/organization:
    - Click "Install App" in the sidebar
    - Select the repositories you want Open-Inspect to access
12. Note the **Installation ID** from the URL after installing:
    ```
    https://github.com/settings/installations/INSTALLATION_ID
    ```

You should now have:

- **App ID** (e.g., `123456`)
- **Client ID** (e.g., `Iv1.abc123...`)
- **Client Secret** (e.g., `abc123...`)
- **Private Key** (PKCS#8 format, starts with `-----BEGIN PRIVATE KEY-----`)
- **Installation ID** (e.g., `12345678`)

---

## Step 4: Create Slack App (Optional)

Skip this step if you don't need Slack integration.

### Create the App

1. Go to [Slack API Apps](https://api.slack.com/apps)
2. Click **"Create New App"** → **"From scratch"**
3. Name it (e.g., `Open-Inspect`) and select your workspace

### Configure OAuth & Permissions

1. Go to **OAuth & Permissions** in the sidebar
2. Add **Bot Token Scopes**:
   - `app_mentions:read`
   - `chat:write`
   - `channels:history`
   - `channels:read`
   - `groups:history`
   - `groups:read`
   - `reactions:write`
3. Click **"Install to Workspace"**
4. Note the **Bot Token** (`xoxb-...`)

> **Important**: If you update bot token scopes later, you must **reinstall the app** to your
> workspace for the new permissions to take effect.

### Get Signing Secret

1. Go to **Basic Information**
2. Note the **Signing Secret**

### Event Subscriptions (Configure After Deployment)

Event Subscriptions require the Slack bot worker to be deployed first for URL verification. You'll
configure this in **Step 7b** after running Terraform.

---

## Step 5: Generate Security Secrets

Generate these random secrets (you'll need them for `terraform.tfvars`):

```bash
# Token encryption key
echo "token_encryption_key: $(openssl rand -base64 32)"

# Repo secrets encryption key
echo "repo_secrets_encryption_key: $(openssl rand -base64 32)"

# Internal callback secret
echo "internal_callback_secret: $(openssl rand -base64 32)"

# Modal API secret (use hex for this one)
echo "modal_api_secret: $(openssl rand -hex 32)"

# NextAuth secret
echo "nextauth_secret: $(openssl rand -base64 32)"

# GitHub webhook secret (only if enabling GitHub bot)
echo "github_webhook_secret: $(openssl rand -hex 32)"
```

Save these values somewhere secure—you'll need them in the next step.

---

## Step 6: Configure Terraform

```bash
cd terraform/environments/production

# Copy the example files
cp terraform.tfvars.example terraform.tfvars
cp backend.tfvars.example backend.tfvars
```

### Configure `backend.tfvars`

Fill in your R2 credentials:

```hcl
access_key = "your-r2-access-key-id"
secret_key = "your-r2-secret-access-key"
endpoints = {
  s3 = "https://YOUR_CLOUDFLARE_ACCOUNT_ID.r2.cloudflarestorage.com"
}
```

### Configure `terraform.tfvars`

Fill in all the values you gathered. Here's the structure:

```hcl
# Provider Authentication
cloudflare_api_token        = "your-cloudflare-api-token"
cloudflare_account_id       = "your-account-id"
cloudflare_worker_subdomain = "your-subdomain"  # e.g., "twilight-unit-b2cf" (without .workers.dev)

vercel_api_token            = "your-vercel-token"
vercel_team_id              = "team_xxxxx"       # Your Vercel ID (even personal accounts have one)
modal_token_id              = "your-modal-token-id"
modal_token_secret          = "your-modal-token-secret"
modal_workspace             = "your-modal-workspace"

# GitHub App (used for both OAuth and repository access)
github_client_id     = "Iv1.abc123..."           # From GitHub App settings
github_client_secret = "your-client-secret"      # Generated in GitHub App settings

github_app_id              = "123456"
github_app_installation_id = "12345678"
github_app_private_key     = <<-EOF
-----BEGIN PRIVATE KEY-----
... paste your PKCS#8 key here ...
-----END PRIVATE KEY-----
EOF

# Slack (set enable_slack_bot = false to disable Slack integration)
enable_slack_bot     = false
slack_bot_token      = ""
slack_signing_secret = ""

# GitHub Bot (set enable_github_bot = true to deploy the webhook worker)
enable_github_bot      = false
github_webhook_secret  = ""          # From Step 5 (required if enabled)
github_bot_username    = ""          # e.g., "my-app[bot]" (your GitHub App's bot login)

# API Keys
anthropic_api_key = "sk-ant-..."

# Security Secrets (from Step 5)
token_encryption_key          = "your-generated-value"
repo_secrets_encryption_key   = "your-generated-value"
internal_callback_secret      = "your-generated-value"
modal_api_secret         = "your-generated-value"
nextauth_secret          = "your-generated-value"

# Configuration
# IMPORTANT: deployment_name must be globally unique for Vercel URLs
# Use your GitHub username, company name, or a random string
deployment_name = "your-unique-name"  # e.g., "acme", "johndoe", "mycompany"
project_root    = "../../../"

# Initial deployment: set both to false (see Step 7)
enable_durable_object_bindings = false
enable_service_bindings        = false

# Access Control (at least one recommended for security)
allowed_users         = "your-github-username"  # Comma-separated GitHub usernames, or empty
allowed_email_domains = ""                      # Comma-separated domains (e.g., "example.com,corp.io")
```

> **Note**: Review `allowed_users` and `allowed_email_domains` carefully - these control who can
> sign in. If both are empty, any GitHub user can access your deployment.

---

## Step 7: Deploy with Terraform

Deployment requires **two phases** due to Cloudflare's Durable Object and service binding
requirements.

### Phase 1: Initial Deployment

Ensure your `terraform.tfvars` has:

```hcl
enable_durable_object_bindings = false
enable_service_bindings        = false
```

**Important**: Build the workers before running Terraform (Terraform references the built bundles):

```bash
# From the repository root
npm run build -w @open-inspect/control-plane -w @open-inspect/slack-bot -w @open-inspect/github-bot
```

Then run:

```bash
cd terraform/environments/production

# Initialize Terraform with backend config
terraform init -backend-config=backend.tfvars

# Deploy (phase 1 - creates workers without bindings)
terraform apply
```

### Phase 2: Enable Bindings

After Phase 1 succeeds, update your `terraform.tfvars`:

```hcl
enable_durable_object_bindings = true
enable_service_bindings        = true
```

Then run:

```bash
terraform apply
```

Terraform will update the workers with the required bindings.

---

## Step 7b: Complete Slack Setup (If Using Slack)

Now that the Slack bot worker is deployed, configure the App Home and Event Subscriptions.

### Enable App Home

The App Home provides a settings interface where users can configure their preferred Claude model.

1. Go to [Slack Apps](https://api.slack.com/apps) -> Your Slack App → **App Home**
2. Under **Show Tabs**, toggle **"Home Tab"** to On

### Configure Event Subscriptions

1. Go to [Slack Apps](https://api.slack.com/apps) -> Your Slack App → **Event Subscriptions**
2. Toggle **"Enable Events"** to On
3. Enter **Request URL**:
   ```
   https://open-inspect-slack-bot-{deployment_name}.YOUR-SUBDOMAIN.workers.dev/events
   ```
   (Replace `YOUR-SUBDOMAIN` with your Cloudflare Workers subdomain and `{deployment_name}` with
   your deployment name from terraform.tfvars)
4. Wait for the green **"Verified"** checkmark
5. Under **Subscribe to bot events**, add:
   - `app_home_opened` (required for App Home settings)
   - `app_mention`
   - `message.channels` (optional - if you want the bot to see all channel messages)
6. Click **Save Changes**

### Configure Interactivity

1. Go to **Interactivity & Shortcuts**
2. Toggle **"Interactivity"** to On
3. Enter **Request URL**:
   ```
   https://open-inspect-slack-bot-{deployment_name}.YOUR-SUBDOMAIN.workers.dev/interactions
   ```
4. Click **Save Changes**

### Invite the Bot to Channels

In Slack, for each channel where you want the bot to respond:

- Type `/invite @YourBotName`, or
- Click the channel name → Integrations → Add apps

The bot only responds to @mentions in channels it has been invited to.

---

## Step 7c: Complete GitHub Bot Setup (If Using GitHub Bot)

Now that the GitHub bot worker is deployed, configure the GitHub App for webhook delivery.

### Configure Webhook on GitHub App

1. Go to your [GitHub App settings](https://github.com/settings/apps)
2. Select your Open-Inspect app
3. Under **Webhook**:
   - Check **"Active"**
   - **Webhook URL**:
     ```
     https://open-inspect-github-bot-{deployment_name}.YOUR-SUBDOMAIN.workers.dev/webhooks/github
     ```
     (Replace `YOUR-SUBDOMAIN` with your Cloudflare Workers subdomain and `{deployment_name}` with
     your deployment name from terraform.tfvars)
   - **Webhook secret**: Enter the `github_webhook_secret` value from your terraform.tfvars
4. Under **Subscribe to events**, check:
   - **Pull requests**
   - **Issue comments**
   - **Pull request review comments**
5. Click **Save changes**

### Find Your Bot Username

Your GitHub App's bot username is its slug with `[bot]` appended. You can find it by:

1. Having the bot perform any action (e.g., a PR review)
2. Checking the actor's login in the webhook payload

Or construct it from your App's slug: if your app is named `My-Inspect-App`, the bot username is
`my-inspect-app[bot]`. Ensure this matches the `github_bot_username` value in your terraform.tfvars.

### Usage

- **Code Review**: Assign the bot as a PR reviewer — it performs an automated review
- **Comment Actions**: @mention the bot in a PR comment with instructions (e.g.,
  `@my-app[bot] fix the failing test`)

---

## Step 8: Deploy the Web App

Terraform creates the Vercel project and configures environment variables, but does **not** deploy
the code. You have two options:

### Option A: Deploy via CLI (Recommended for First Deploy)

```bash
# From the repository root (replace {deployment_name} with your value from terraform.tfvars)
npx vercel link --project open-inspect-{deployment_name}
npx vercel --prod
```

> **Note**: The Vercel project is configured with custom build commands for the monorepo structure.
> Terraform sets these automatically:
>
> - Install: `cd ../.. && npm install && npm run build -w @open-inspect/shared`
> - Build: `next build`

### Option B: Link Git Repository (For Automatic Deployments)

1. Go to [Vercel Dashboard](https://vercel.com/dashboard)
2. Find the `open-inspect-{deployment_name}` project
3. Go to **Settings → Git**
4. Click **"Connect Git Repository"** and select your fork
5. Vercel will automatically deploy on push to main

> **Note**: If you link Git, ensure the build settings match those configured by Terraform (Settings
> → General → Build & Development Settings).

---

## Step 9: Verify Deployment

After deployment completes, verify each component:

```bash
# Get the verification commands from Terraform
terraform output verification_commands
```

Or manually:

```bash
# 1. Control Plane health check (replace {deployment_name} and YOUR-SUBDOMAIN)
curl https://open-inspect-control-plane-{deployment_name}.YOUR-SUBDOMAIN.workers.dev/health

# 2. Modal health check (replace YOUR-WORKSPACE)
curl https://YOUR-WORKSPACE--open-inspect-api-health.modal.run

# 3. Web app (replace {deployment_name}, should return 200)
curl -I https://open-inspect-{deployment_name}.vercel.app
```

### Test the Full Flow

1. Visit your web app URL
2. Sign in with GitHub
3. Create a new session with a repository
4. Send a prompt and verify the sandbox starts

---

## Step 10: Set Up CI/CD (Optional)

Enable automatic deployments when you push to main by adding GitHub Secrets.

Go to your fork's Settings → Secrets and variables → Actions, and add:

| Secret Name                   | Value                                                                         |
| ----------------------------- | ----------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`        | Your Cloudflare API token                                                     |
| `CLOUDFLARE_ACCOUNT_ID`       | Your Cloudflare account ID                                                    |
| `CLOUDFLARE_WORKER_SUBDOMAIN` | Your workers.dev subdomain                                                    |
| `R2_ACCESS_KEY_ID`            | R2 access key ID                                                              |
| `R2_SECRET_ACCESS_KEY`        | R2 secret access key                                                          |
| `VERCEL_API_TOKEN`            | Vercel API token                                                              |
| `VERCEL_TEAM_ID`              | Vercel team/account ID                                                        |
| `VERCEL_PROJECT_ID`           | Vercel project ID (from project settings)                                     |
| `NEXTAUTH_URL`                | Your web app URL (e.g., `https://open-inspect-{deployment_name}.vercel.app`)  |
| `MODAL_TOKEN_ID`              | Modal token ID                                                                |
| `MODAL_TOKEN_SECRET`          | Modal token secret                                                            |
| `MODAL_WORKSPACE`             | Modal workspace name                                                          |
| `GH_APP_CLIENT_ID`            | GitHub App client ID                                                          |
| `GH_APP_CLIENT_SECRET`        | GitHub App client secret                                                      |
| `GH_APP_ID`                   | GitHub App ID                                                                 |
| `GH_APP_PRIVATE_KEY`          | GitHub App private key (PKCS#8 format)                                        |
| `GH_APP_INSTALLATION_ID`      | GitHub App installation ID                                                    |
| `ENABLE_SLACK_BOT`            | `true` to deploy Slack bot, `false` to skip (default: `true`)                 |
| `SLACK_BOT_TOKEN`             | Slack bot token (required if enabled)                                         |
| `SLACK_SIGNING_SECRET`        | Slack signing secret (required if enabled)                                    |
| `ANTHROPIC_API_KEY`           | Anthropic API key                                                             |
| `TOKEN_ENCRYPTION_KEY`        | Generated encryption key (OAuth tokens)                                       |
| `REPO_SECRETS_ENCRYPTION_KEY` | Generated encryption key (repo secrets)                                       |
| `INTERNAL_CALLBACK_SECRET`    | Generated callback secret                                                     |
| `MODAL_API_SECRET`            | Generated Modal API secret                                                    |
| `NEXTAUTH_SECRET`             | Generated NextAuth secret                                                     |
| `ALLOWED_USERS`               | Comma-separated GitHub usernames (or empty for all users)                     |
| `ALLOWED_EMAIL_DOMAINS`       | Comma-separated email domains (or empty for all domains)                      |
| `ENABLE_GITHUB_BOT`           | `true` to deploy GitHub bot worker (or empty to skip)                         |
| `GH_WEBHOOK_SECRET`           | GitHub webhook secret (required if GitHub bot enabled)                        |
| `GH_BOT_USERNAME`             | GitHub App bot username, e.g., `my-app[bot]` (required if GitHub bot enabled) |

**Bulk upload secrets with `gh` CLI:**

Instead of adding secrets one by one, create a `.secrets` file (don't commit this!):

```
CLOUDFLARE_API_TOKEN=your-token
CLOUDFLARE_ACCOUNT_ID=your-account-id
ANTHROPIC_API_KEY=sk-ant-...
# ... add all secrets
```

Then upload all at once (run from your fork's directory, or use
`-R {your_github_username}/{background-agents}`):

```bash
gh secret set -f .secrets
```

Once configured, the GitHub Actions workflow will:

- Run `terraform plan` on pull requests (with PR comment)
- Run `terraform apply` when merged to main

---

## Updating Your Deployment

To update after pulling changes from upstream:

```bash
# Pull latest changes
git pull upstream main

# Rebuild shared package if it changed
npm run build -w @open-inspect/shared

# Re-run Terraform (it only changes what's needed)
cd terraform/environments/production
terraform apply
```

---

## Troubleshooting

### "Backend initialization required"

Re-run init with backend config:

```bash
terraform init -backend-config=backend.tfvars
```

### GitHub App authentication fails

1. Verify the private key is in PKCS#8 format (starts with `-----BEGIN PRIVATE KEY-----`)
2. Check the Installation ID matches your installation
3. Ensure the app has required permissions on the repository
4. Verify the callback URL matches your deployed Vercel URL exactly

### GitHub OAuth "redirect_uri is not associated with this application"

The callback URL in your GitHub App settings doesn't match your deployed URL. Update the callback
URL to match `https://open-inspect-{deployment_name}.vercel.app/api/auth/callback/github`.

### Modal deployment fails

```bash
# Check Modal CLI is working
modal token show

# View Modal logs
modal app logs open-inspect
```

### Worker deployment fails / "no such file or directory" for dist/index.js

Terraform references the built worker bundles. Build them before running `terraform apply`:

```bash
# Build shared package first
npm run build -w @open-inspect/shared

# Build workers (required before Terraform)
npm run build -w @open-inspect/control-plane -w @open-inspect/slack-bot -w @open-inspect/github-bot

# Verify bundles exist
ls packages/control-plane/dist/index.js
ls packages/slack-bot/dist/index.js
ls packages/github-bot/dist/index.js  # Only if enable_github_bot = true
```

### Slack bot not responding

1. Verify Event Subscriptions URL is verified (green checkmark)
2. Ensure the bot is invited to the channel (`/invite @BotName`)
3. Check that you're @mentioning the bot in your message
4. If you updated bot token scopes, reinstall the app to your workspace

### Slack bot ignores thread context

If the bot doesn't see the original message when tagged in a thread reply:

1. Verify the bot has `channels:history` scope (for public channels) and `groups:history` (for
   private channels). These are required by the `conversations.replies` API to fetch thread
   messages.
2. Verify the bot has `channels:read` and `groups:read` scopes. These are required by
   `conversations.info` to fetch channel name and description for context.
3. If you added missing scopes, **reinstall the app** to your workspace for the new permissions to
   take effect.

### GitHub bot not responding to webhooks

1. Verify the webhook URL matches
   `https://open-inspect-github-bot-{deployment_name}.YOUR-SUBDOMAIN.workers.dev/webhooks/github`
2. Check the webhook secret matches `github_webhook_secret` in terraform.tfvars
3. Confirm `enable_github_bot = true` in terraform.tfvars and the worker is deployed
4. Check that `github_bot_username` matches your App's bot login (e.g., `my-app[bot]`)
5. For PR reviews, ensure the bot is assigned as a reviewer (not just mentioned)
6. For comment actions, ensure the bot is @mentioned in a **PR** comment (not an issue)

### Durable Objects / Service Binding errors

This occurs on first deployment. Follow the two-phase deployment process:

1. Deploy with `enable_durable_object_bindings = false` and `enable_service_bindings = false`
2. After success, set both to `true` and run `terraform apply` again

---

## Security Notes

- **Never commit** `terraform.tfvars` or `backend.tfvars` to source control
- The `.gitignore` already excludes these files
- Use GitHub Secrets for CI/CD, not hardcoded values
- Rotate secrets periodically using `terraform apply` after updating `terraform.tfvars`
- Review the [Security Model](../README.md#security-model-single-tenant-only) - this system is
  designed for single-tenant deployment

---

## Architecture Reference

For details on the infrastructure components, see:

- [terraform/README.md](../terraform/README.md) - Terraform module documentation
- [README.md](../README.md) - System architecture overview
- [OPENAI_MODELS.md](OPENAI_MODELS.md) - Configuring OpenAI Codex models
