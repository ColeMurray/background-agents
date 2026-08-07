# Using OpenAI Models

Open-Inspect supports OpenAI Codex models in addition to Anthropic Claude models. This guide covers
the managed ChatGPT OAuth transport used by sessions and by optional Slack target classification.

> **Note**: This setup process is temporary and will be streamlined in a future release.

---

## Supported Models

For the full model list, including Claude Fable 5 and other Anthropic models, see
[Available Models](AVAILABLE_MODELS.md).

| Model               | Description                                |
| ------------------- | ------------------------------------------ |
| GPT 5.4             | Flagship model                             |
| GPT 5.5             | Latest flagship model                      |
| GPT 5.6 Luna        | Fast, cost-efficient high-volume workloads |
| GPT 5.3 Codex       | Latest codex variant                       |
| GPT 5.3 Codex Spark | Lightweight Codex variant                  |

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
6. From the `openai` section, copy the `refresh` value (the refresh token). The `accountId` value is
   optional; the managed transport learns and rotates it from the OAuth response when needed.

### Step 2: Add Secrets to Your Deployment

1. Go to your Open-Inspect web app's **Settings** page.
2. For normal sessions, credentials may be stored as global, repository, or environment secrets; the
   selected session target determines which scope is read.
3. For Slack target classification, the target is not known yet. Add the refresh token to the
   **global** scope — repository and environment tokens cannot be used for this pre-target call.
4. Add the following secrets:

   | Secret Name                  | Value                                                              |
   | ---------------------------- | ------------------------------------------------------------------ |
   | `OPENAI_OAUTH_REFRESH_TOKEN` | The `refresh` token from Step 1 (global for Slack classification)  |
   | `OPENAI_OAUTH_ACCOUNT_ID`    | Optional ChatGPT account ID; the managed transport can populate it |

Open-Inspect uses the existing managed ChatGPT OAuth transport; it does not use an `OPENAI_API_KEY`
for these flows. The refresh token remains in the control plane, which brokers short-lived access to
the model.

### Step 3: Select an OpenAI Model

When creating a new session, choose any OpenAI model from the model dropdown. Sessions using OpenAI
models will automatically use your configured credentials.

---

## How It Works

Your refresh token is stored securely in the control plane and is never exposed to sandboxes. When a
sandbox needs to make an OpenAI API call, it requests a short-lived access token from the control
plane, which handles token refresh and rotation automatically. Only the temporary access token is
present inside the sandbox.

Credentials can be scoped globally, per repository, or per environment, so different targets can use
different OpenAI accounts.

### Slack target-classification rollout

Slack classification is deployment-wide because it runs before a repository or environment is known.
Roll it out in three stages:

1. Deploy the classification support. Terraform keeps Anthropic as the default with
   `slack_classification_model = "anthropic/claude-haiku-4-5"`, so existing deployments are
   unchanged.
2. Configure `OPENAI_OAUTH_REFRESH_TOKEN` in **global** secrets using the steps above. Do not put
   the pre-target credential only on a repository or environment, and do not add an
   `OPENAI_API_KEY`.
3. Switch the deployment to `slack_classification_model = "openai/gpt-5.6-luna"` and run
   `terraform apply`. Verify a Slack request that resolves to a repository or environment.

---

## Troubleshooting

### Model doesn't appear in the dropdown

Ensure your deployment is up to date. OpenAI model support requires the latest version of
Open-Inspect.

### Session fails to start with an OpenAI model

Verify that `OPENAI_OAUTH_REFRESH_TOKEN` is set in your session target's secrets (or global
secrets). `OPENAI_OAUTH_ACCOUNT_ID` may be omitted when the managed transport can derive it. The
refresh token may have expired — repeat Step 1 to obtain fresh credentials.

### Slack classification cannot reach OpenAI

Verify that `OPENAI_OAUTH_REFRESH_TOKEN` is present in **global** secrets. Slack classification runs
before the target repository or environment is known, so repository and environment secrets are not
available. This flow uses managed ChatGPT OAuth and never `OPENAI_API_KEY`.

### "Token refresh failed" errors

The OAuth refresh token may have been revoked or expired. Re-authenticate by repeating Step 1 and
updating the secrets in your Settings page.
