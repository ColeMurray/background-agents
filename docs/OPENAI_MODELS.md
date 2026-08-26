# Using OpenAI Models

Open-Inspect supports OpenAI Codex models in addition to Anthropic Claude models. This guide covers
how to configure your deployment to use them.

OpenAI subscriptions are managed as installation-wide provider accounts. Sessions and automations
can use the installation default, select a specific account, or explicitly use API-key mode.

---

## Supported Models

For the full model list, including Claude Fable 5 and other Anthropic models, see
[Available Models](AVAILABLE_MODELS.md).

| Model               | Description               |
| ------------------- | ------------------------- |
| GPT 5.4             | Flagship model            |
| GPT 5.5             | Latest flagship model     |
| GPT 5.3 Codex       | Latest codex variant      |
| GPT 5.3 Codex Spark | Lightweight Codex variant |

OpenAI models support reasoning effort levels: none, low, medium, high, and extra high (default:
high for Codex models).

---

## Setup

### Step 1: Connect ChatGPT

1. Open **Settings > Provider Accounts**.
2. Choose **Add account > ChatGPT**. Device authorization starts automatically.
3. Use **Open ChatGPT Settings** and enable device code authorization for Codex.
4. Use **Open Device Authorization**, then enter the code shown by Open-Inspect when OpenAI asks for
   it.
5. Keep the dialog open while Open-Inspect waits for authorization. The new account appears after
   OpenAI confirms the connection.

Open-Inspect creates the account as **ChatGPT account** by default. Use **Rename** afterward if you
want a different display name. Provider accounts are shared by all admitted users in this
single-tenant deployment; they are not repository-scoped or private to their creator.

### Step 2: Configure Defaults

In the OpenAI section of **Settings > Provider Accounts**:

1. Choose the **Default account** used when an interactive session follows provider policy.
2. Choose **Unattended mode**:
   - **Use default account** makes Slack, GitHub, Linear, and unpinned automation runs use the
     subscription account.
   - **Use API key** keeps unattended launches on the existing API-key path.

Defaults are resolved when a session starts. Changing them does not move a running session to a
different paid account.

### Step 3: Select Authentication

Choose an OpenAI model when creating a session and use the **OpenAI authentication** selector to
choose provider policy, a specific connected account, or **Use API key**. Account mode overrides
`OPENAI_API_KEY` for that session.

Automation editors expose the same choices for every subscription provider. **Use defaults when each
run starts** resolves current policy for every run; selecting an account or API-key mode pins that
choice for future runs.

---

## How It Works

The OpenAI device authorization result is encrypted with `PROVIDER_ACCOUNTS_ENCRYPTION_KEY` in the
control plane and is never exposed to the browser or sandboxes. A session stores the selected
account ID, not credential material. When the sandbox needs OpenAI access, its runtime plugin calls
the sandbox-authenticated `POST /sessions/:id/provider-auth/openai/access-token` endpoint. The
control plane refreshes and rotates the account credential and returns only short-lived access
material.

Children inherit their parent's pinned provider authentication. Disabling or archiving an account
blocks future broker calls, but an access token already issued to a running sandbox remains usable
until it expires.

## Deployment and Coexistence

Legacy scoped OAuth and provider accounts can coexist. Existing sessions retain their legacy
binding. Add and verify provider accounts at any time, then set a provider default when new sessions
should use that account. Defaults never move existing sessions. The settings page lists remaining
legacy OAuth key locations; remove them only after dependent legacy-bound sessions are no longer
needed. Older manually provisioned credentials continue to work, but new ChatGPT accounts should use
the first-party device authorization flow in Settings. Do not copy the same rotating refresh token
into both credential systems.

---

## Troubleshooting

### Model doesn't appear in the dropdown

Ensure your deployment is up to date. OpenAI model support requires the latest version of
Open-Inspect.

### Session fails to start with an OpenAI model

Confirm that the selected/default OpenAI account is active and the account is verified. If the
session explicitly uses API-key mode, confirm `OPENAI_API_KEY` is available in its secret scope.

### "Token refresh failed" errors

The OAuth grant may have been revoked, expired, or rotated elsewhere. Use **Reconnect** on the
existing account and complete the same device authorization flow. Reconnect preserves the account's
display name and must authenticate the same OpenAI account identity; connect a new provider account
if the identity changed.
