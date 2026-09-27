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
3. Credential collection (Cloudflare, Vercel if selected, Modal, Anthropic)
4. GitHub App creation (+ Google OAuth if enabled)
5. Slack App creation (if enabled)
6. Security secrets generation
7. Terraform configuration
8. Terraform deployment (two phases)
9. Post-deployment Slack setup (if enabled)
10. Post-deployment GitHub Bot setup (if enabled)
11. Web app deployment
12. Workspace Owner bootstrap
13. Verification
14. CI/CD setup (optional)

## Phase 1: Initial Questions

First, generate a random suffix suggestion for the user:

```bash
echo "Suggested deployment name: $(openssl rand -hex 3)"
```

Use AskUserQuestion to gather:

1. **Directory location** - Where to create the project (default: current directory or
   ~/workplace/open-inspect-{suffix})
2. **GitHub account** - Which account/org hosts the private repo
3. **Deployment name** - A unique identifier for deployment URLs (e.g., their GitHub username,
   company name, or the random suffix generated above); Vercel project URLs must be globally unique.
4. **Web platform** - Vercel (default) or Cloudflare Workers. If Cloudflare, ask whether to use a
   custom domain; if so, collect the hostname and Cloudflare zone ID. Derive one canonical web app
   URL from this choice and the deployment name using Step 3 of `docs/GETTING_STARTED.md`; use it
   for both OAuth callbacks and the GitHub App homepage.
5. **Slack integration** - Yes or No
6. **GitHub bot integration** - Yes or No (automated PR reviews and comment-triggered actions)
7. **Sign-in providers** - GitHub, Google, or both. At least one is required.
8. **Admission mode** - Restricted (collect the allowed GitHub usernames, exact verified emails,
   email domains, and/or GitHub orgs) or explicitly open to any authenticated user (no allowlists).
   Validate the chosen providers and admission mode against the compatibility table and allowlist
   rules in Step 6 of `docs/GETTING_STARTED.md` before proceeding.
9. **Prerequisites confirmation** - Confirm they have Cloudflare, Modal, Anthropic, and GitHub
   accounts, plus Vercel only if selected above.

## Phase 2: Repository Setup

Execute these commands (substitute values from Phase 1):

```bash
mkdir -p {directory_path}
gh repo create {github_account}/open-inspect-{name} --private --description "Open-Inspect deployment"
cd {directory_path}
git clone git@github.com:ColeMurray/background-agents.git .
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
  (Edit), Queues (Edit). For a Cloudflare web app with a custom domain, also grant zone-level
  Workers Routes (Edit).

### R2 Bucket

Check wrangler login status, then create bucket:

```bash
wrangler whoami
wrangler r2 bucket create open-inspect-terraform-state
```

Tell user to create R2 API Token at R2 → Overview → Manage R2 API Tokens with "Object Read & Write"
permission.

### Vercel (Only If Selected In Phase 1)

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

Guide the user through creating a GitHub App. Its App ID, private key, and installation ID are
always required for repository access. Its client ID and secret enable GitHub sign-in only when the
user selected GitHub:

1. Go to https://github.com/settings/apps → "New GitHub App"
2. **Name**: `Open-Inspect-{YourName}` (globally unique)
3. **Homepage URL**: The canonical web app URL from Phase 1
4. **Webhook**: Uncheck "Active"
5. If GitHub sign-in is selected, set the **Callback URL** (under "Identifying and authorizing
   users"): `{canonical-web-app-url}/api/auth/callback/github`
   - **CRITICAL**: The origin must exactly match the Homepage URL selected above.
6. **Repository permissions**: Contents (Read & Write), Pull requests (Read & Write), Metadata
   (Read-only). If the GitHub bot is enabled, also grant Actions (Read-only), Checks (Read-only),
   and Issues (Read & Write). Pull requests permission also authorizes creating and applying labels
   to session-created pull requests; labeling does not require Issues permission.
7. If GitHub organizations are allowlisted, set **Organization permissions**: Members (Read-only).
   Existing Apps need the permission change approved on their installations.
8. If GitHub sign-in is enabled, set **Account permissions**: Email addresses (Read-only). Every
   GitHub sign-in requires a verified email, regardless of admission mode. Existing Apps need the
   permission change approved on their installations.
9. Create app, note **App ID**
10. If GitHub sign-in is selected, generate a **Client Secret** and note the **Client ID** and
    **Client Secret**. Otherwise leave both Terraform values empty.
11. Generate **Private Key** (downloads .pem file)
12. Install app on account, note **Installation ID** from URL

After receiving the .pem path, convert to PKCS#8:

```bash
openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in {pem_path} -out /tmp/github-app-key-pkcs8.pem
cat /tmp/github-app-key-pkcs8.pem
```

## Phase 4b: Google OAuth Setup (If Enabled)

Only if the user selected Google sign-in. Skip for GitHub-only deployments and leave
`google_client_id` and `google_client_secret` empty.

Guide user:

1. https://console.cloud.google.com/apis/credentials → "Create Credentials" → "OAuth client ID"
2. **Application type**: Web application
3. **Authorized redirect URI**: `{canonical-web-app-url}/api/auth/callback/google`
   - **CRITICAL**: Must match the web URL from Phase 1 exactly!
4. OAuth consent screen: request only `openid`, `email`, `profile` scopes (non-sensitive — no Google
   verification review required)
5. Note **Client ID** and **Client Secret**

Then in `terraform.tfvars`:

- Set `google_client_id` and `google_client_secret` (both required together; leave both empty to
  disable)
- If Google is the only sign-in provider, leave `github_client_id` and `github_client_secret` empty.
  Keep the GitHub App ID, private key, and installation ID configured for repository access.

The next request to `/login` shows Google after both credentials are deployed; no separate web flag
or rebuild is required. Google users get the same flat access; their PRs fall back to the App bot
unless the same verified email is also a linked GitHub identity.

## Phase 5: Slack App Setup (If Enabled)

Guide user:

1. https://api.slack.com/apps → "Create New App" → "From scratch"
2. OAuth & Permissions → Add scopes: `assistant:write`, `app_mentions:read`, `chat:write`,
   `channels:history`, `channels:read`, `groups:history`, `groups:read`, `im:history`, `files:read`,
   `files:write`, `reactions:write`, `users:read`, `users:read.email`
3. Install to Workspace, note **Bot Token** (`xoxb-...`)
4. Basic Information → note **Signing Secret**
5. **App Home and Event Subscriptions configured AFTER deployment** (worker must be running for URL
   verification)

`files:read` forwards user-attached images into sessions; `files:write` posts generated media back
to Slack. Reinstall the app whenever either scope is added to an existing installation.

## Phase 6: Generate Security Secrets

```bash
echo "token_encryption_key: $(openssl rand -base64 32)"
echo "repo_secrets_encryption_key: $(openssl rand -base64 32)"
echo "nextauth_secret: $(openssl rand -base64 32)"
echo "modal_api_secret: $(openssl rand -hex 32)"
echo "github_webhook_secret: $(openssl rand -hex 32)"  # Only if GitHub bot enabled
```

## Phase 7: Terraform Configuration

Create `terraform/environments/production/backend.tfvars`. The bucket is already fixed as
`open-inspect-terraform-state` in `backend.tf`; do not override it here:

```hcl
access_key = "{r2_access_key}"
secret_key = "{r2_secret_key}"
endpoints = {
  s3 = "https://{cloudflare_account_id}.r2.cloudflarestorage.com"
}
```

Create `terraform/environments/production/terraform.tfvars` with all collected values. Set:

```hcl
web_platform                   = "{vercel_or_cloudflare_from_phase_1}"
enable_durable_object_bindings = false
enable_service_bindings        = false
```

If Phase 1 selected a Cloudflare custom domain, also set `cloudflare_custom_domain` and
`cloudflare_zone_id` to the collected hostname and zone ID. Leave both unset otherwise. If Vercel
was not selected, leave `vercel_api_token` and `vercel_team_id` unset (not empty strings).

Write the restricted-mode comma-separated Phase 1 answers to `allowed_users`,
`allowed_email_domains`, `allowed_emails`, and `allowed_github_orgs`; leave unused inputs empty and
set `unsafe_allow_all_users = false`. For explicitly open mode, leave all four lists empty and set
`unsafe_allow_all_users = true`. Use Step 6 of `docs/GETTING_STARTED.md` for the admission contract.

If GitHub bot is enabled, also set:

```hcl
enable_github_bot     = true
github_webhook_secret = "{generated_value}"
github_bot_username   = "{app-slug}[bot]"
```

## Phase 8: Terraform Deployment (Two-Phase)

**Important**: Build the workers before running Terraform (Terraform references the built bundles):

```bash
npm run build -w @open-inspect/control-plane -w @open-inspect/slack-bot -w @open-inspect/github-bot
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

The user can apply `packages/slack-bot/slack-app-manifest.yaml` instead of configuring the following
settings individually. Replace `SLACK_EVENTS_URL` with the worker's `/events` URL and
`SLACK_INTERACTIONS_URL` with its `/interactions` URL first. The template includes
`message.channels` and `message.groups` for channel-message automations; remove them if the
deployment will not use that feature.

OAuth scopes, app installation, the bot token, and the signing secret must be configured before
`terraform apply`. Apply the URL-dependent manifest after deployment.

### Enable Agents

1. Agents → Enable the agent feature
2. Set the agent description to `AI coding assistant for your codebase`

### Enable App Home

1. App Home → Show Tabs → Enable **"Home Tab"**
2. Enable **"Messages Tab"** and allow users to send messages
3. Save Changes

The App Home provides settings for users' preferred model, reasoning effort, and branch. The
writable Messages tab lets users start direct-message sessions.

### Configure Event Subscriptions

1. Event Subscriptions → Enable → Request URL from `terraform output -raw slack_bot_events_url`
2. Wait for "Verified" checkmark
3. Subscribe to bot events: `app_home_opened`, `app_mention`, `message.channels`, `message.groups`,
   `message.im`

### Configure Interactivity

4. Interactivity → Enable → Request URL from `terraform output -raw slack_bot_interactions_url`
5. Select Menus → Use the same URL for **Options Load URL**. This is required for searchable Slack
   repository pickers that use external data sources.

### Invite Bot to Channels

6. Invite bot to channels: `/invite @BotName`

## Phase 10: Complete GitHub Bot Setup (If Enabled)

After Terraform deployment, guide user:

### Configure Webhook on GitHub App

1. Go to GitHub App settings → your app
2. Under **Webhook**: check **"Active"**
3. **Webhook URL**:
   `https://open-inspect-github-bot-{deployment_name}.{subdomain}.workers.dev/webhooks/github`
4. **Webhook secret**: Enter the `github_webhook_secret` value
5. Under **Subscribe to events**, check: **Pull requests**, **Issues**, **Issue comments**, **Pull
   request reviews**, **Pull request review comments**, **Check suites**, **Workflow runs**
6. Save changes

### Find Bot Username

The bot username is the App's slug with `[bot]` appended. E.g., if the app is `My-Inspect-App`, the
bot username is `my-inspect-app[bot]`. Confirm this matches `github_bot_username` in
terraform.tfvars.

### Usage

- **Code Review**: Assign the bot as a PR reviewer
- **Comment Actions**: @mention the bot in a PR comment with instructions

## Phase 11: Web App Deployment

For the Cloudflare choice from Phase 1, Terraform deploys the web app; no manual step is needed. For
Vercel, deploy from the repository root:

```bash
npx vercel link --project open-inspect-{deployment_name}
npx vercel --prod
```

## Phase 12: Bootstrap the Workspace Owner

After the web app is deployed, guide the intended Owner through Step 7a of
`docs/GETTING_STARTED.md`. Obtain their canonical user ID after sign-in; run
`npm run rbac:bootstrap-owner` from the repository root as a dry run, execute only if ready, and
verify by rerunning the dry run. Follow Step 7a for commands and refusal/no-op handling.

## Phase 13: Verification

From the repository root:

```bash
curl https://open-inspect-control-plane-{deployment_name}.{subdomain}.workers.dev/health
curl https://{workspace}--open-inspect-api-health.modal.run
curl -I "$(terraform -chdir=terraform/environments/production output -raw web_app_url)"
```

Present a deployment summary table. Instruct the user to test: visit the web app, sign in with each
configured provider, create a session, and send a prompt.

## Phase 14: CI/CD Setup (Optional)

Ask if user wants GitHub Actions CI/CD. If yes, follow Step 10 of `docs/GETTING_STARTED.md` for the
required variables and secrets, including the Phase 1 admission mode and allowlists. CI uses the
same `open-inspect-terraform-state` R2 bucket as local Terraform.

## Error Handling

- **"redirect_uri is not associated"**: Callback URL mismatch - update GitHub App settings
- **Durable Object errors**: Must follow two-phase deployment
- **"At least one access control allowlist must be configured"**: Set an appropriate `allowed_*`
  Terraform value or the explicit Phase 1 open-access choice; check Step 6 of
  `docs/GETTING_STARTED.md` and the corresponding CI variables/secrets.
- **Queue creation or binding permission errors**: Grant Account | Queues | Edit to the Cloudflare
  API token and rerun `terraform apply`.
- **Slack bot not responding**: Check Event Subscriptions URL verified, bot invited to channel,
  reinstall if scopes changed
- **GitHub bot not responding**: Check webhook URL, secret, `enable_github_bot = true`, and
  `github_bot_username` matches the App's bot login
- **Vercel build fails**: Terraform configures the monorepo build commands automatically
- **"no such file or directory" for dist/index.js**: Build workers before Terraform:
  `npm run build -w @open-inspect/control-plane -w @open-inspect/slack-bot -w @open-inspect/github-bot`
- **Worker deployment fails**: Build shared package first: `npm run build -w @open-inspect/shared`

## Important Notes

- Track all collected credentials securely throughout the process
- Never log sensitive values
- The callback URL MUST match the actual deployed web app URL
- Two-phase Terraform deployment is required due to Cloudflare Durable Object constraints
