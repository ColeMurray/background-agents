# Using OpenAI Models

Open-Inspect supports OpenAI Codex models in addition to Anthropic Claude models. This guide covers
how to configure your deployment to use them.

> **Note**: This setup process is temporary and will be streamlined in a future release.

---

## Supported Models

| Model         | Description                    |
| ------------- | ------------------------------ |
| GPT 5.2       | Fast baseline model (400K ctx) |
| GPT 5.2 Codex | Optimized for code tasks       |
| GPT 5.3 Codex | Latest codex variant           |

OpenAI models support reasoning effort levels: none, low, medium, high, and extra high (default:
high for Codex models).

---

## Setup

### Step 1: Obtain OpenAI OAuth Credentials

You'll use [OpenCode](https://opencode.ai) locally to authenticate with OpenAI and retrieve the
required tokens.

1. Install OpenCode if you haven't already
2. Launch OpenCode:
   ```bash
   opencode
   ```
3. Inside OpenCode, run `/connect setup`
4. Select **ChatGPT** and complete the OAuth login flow in your browser
5. After authenticating, open the credentials file:
   ```bash
   cat ~/.local/share/opencode/auth.json
   ```
6. From the `openai` section, copy the values for:
   - `refresh` — the refresh token
   - `accountId` — your ChatGPT account ID

### Step 2: Add Secrets to Your Deployment

1. Go to your Open-Inspect web app's **Settings** page
2. Add the following repository secrets:

   | Secret Name                  | Value                           |
   | ---------------------------- | ------------------------------- |
   | `OPENAI_OAUTH_REFRESH_TOKEN` | The `refresh` token from Step 1 |
   | `OPENAI_OAUTH_ACCOUNT_ID`    | The `accountId` from Step 1     |

### Step 3: Select an OpenAI Model

When creating a new session, choose any OpenAI model from the model dropdown. Sessions using OpenAI
models will automatically use your configured credentials.

---

## How It Works

Your refresh token is stored securely in the control plane and is never exposed to sandboxes. When a
sandbox needs to make an OpenAI API call, it requests a short-lived access token from the control
plane, which handles token refresh and rotation automatically. Only the temporary access token is
present inside the sandbox.

Credentials are scoped per repository, so different repos can use different OpenAI accounts.

---

## Troubleshooting

### Model doesn't appear in the dropdown

Ensure your deployment is up to date. OpenAI model support requires the latest version of
Open-Inspect.

### Session fails to start with an OpenAI model

Verify that both `OPENAI_OAUTH_REFRESH_TOKEN` and `OPENAI_OAUTH_ACCOUNT_ID` are set in your
repository secrets (Settings page). The refresh token may have expired — repeat Step 1 to obtain
fresh credentials.

### "Token refresh failed" errors

The OAuth refresh token may have been revoked or expired. Re-authenticate by repeating Step 1 and
updating the secrets in your Settings page.
