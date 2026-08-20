# Using OpenAI Models

Open-Inspect supports OpenAI Codex models in addition to Anthropic Claude models. This guide covers
how to configure your deployment to use them.

> **Note**: This setup process is temporary and will be streamlined in a future release.

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

There are three ways to pay for OpenAI models:

| Secrets                                      | Billing                                               | Setup                                                            |
| -------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------- |
| `OPENAI_OAUTH_*` (ChatGPT Plus/Pro)          | Included in the subscription; fails at its quota      | [Steps 1–3](#step-1-obtain-openai-oauth-credentials)             |
| `OPENAI_API_KEY`                             | Metered, per token                                    | [Using an API key](#using-an-api-key)                            |
| `OPENAI_OAUTH_*` + `OPENAI_API_KEY_FALLBACK` | Subscription up to a ceiling you choose, then metered | [Spilling over](#spilling-over-before-the-subscription-runs-out) |

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

## Using an API key

Instead of a ChatGPT subscription, add a single secret on the **Settings** page:

| Secret Name      | Value                                                           |
| ---------------- | --------------------------------------------------------------- |
| `OPENAI_API_KEY` | A key from https://platform.openai.com/api-keys (`sk-proj-...`) |

Global scope makes every session use it; repository or environment scope narrows it to one target.
All OpenAI models in the dropdown — including the Codex variants — are available this way, billed to
the key's project.

**An API key wins over the managed subscription.** When a session can see `OPENAI_API_KEY`, the
control plane skips OAuth broker mode for OpenAI, so the sandbox talks to `api.openai.com` with the
key. The `OPENAI_OAUTH_*` secrets can stay in place; delete the `OPENAI_API_KEY` secret to switch
back to the subscription. The same precedence applies to xAI (`XAI_API_KEY` over SuperGrok OAuth).

Unlike the OAuth path, the key itself is injected into the sandbox environment, because OpenCode
reads `OPENAI_API_KEY` directly.

---

## Spilling over before the subscription runs out

A ChatGPT subscription that hits its Codex quota fails the session outright:
`Execution failed: The usage limit has been reached...`. To keep working on a per-token key — and,
if you want, to stop Open-Inspect from eating the whole subscription in the first place — add:

| Secret Name                       | Value                                                                     |
| --------------------------------- | ------------------------------------------------------------------------- |
| `OPENAI_API_KEY_FALLBACK`         | A platform API key, used only as a spillover                              |
| `OPENAI_SUBSCRIPTION_MAX_PERCENT` | Optional share of a rate-limit window sandboxes may consume (default 100) |

Keep the `OPENAI_OAUTH_*` secrets in place and do **not** set `OPENAI_API_KEY` (that would switch
every call to metered billing). Set `OPENAI_SUBSCRIPTION_MAX_PERCENT` to `80` to reserve the last
fifth of each window for whoever else uses that ChatGPT account.

Each sandbox then sends OpenAI traffic to the subscription until one of these happens, after which
it uses the fallback key for the rest of its life:

- usage is already at or above the ceiling when the sandbox starts. The percentage is read from
  `GET /backend-api/wham/usage`, which reports both windows without consuming any of them, so the
  first turn does not have to overshoot the ceiling to discover it
- a Codex response reports either window at or above the ceiling. On a successful response the
  in-flight reply is kept and only the next request moves over, because a started stream cannot be
  replayed
- Codex answers `429` with a quota signal: `x-codex-rate-limit-reached-type`, a usage-limit message,
  or a window at or above the ceiling. That request is retried on the fallback key immediately
- the control plane cannot mint a subscription access token at all (revoked or expired refresh
  token)

A plain `429` with no quota signal is passed through untouched, so short-window throttling does not
spend money. Both windows count: Codex tracks a short (roughly 5-hour) and a weekly window, and the
higher usage of the two decides. An unparseable ceiling is ignored with a log line and treated
as 100. If the usage probe fails, the sandbox stays on the subscription and relies on response
headers instead.

Every switch is logged in the session's sandbox logs as
`[codex-auth-plugin] spilling OpenAI traffic over to OPENAI_API_KEY_FALLBACK: <reason>`.

Two caveats: the latch lasts as long as the sandbox, so a session that spilled over stays on the key
even if the window resets under it, and OpenCode still reports OpenAI token costs as `0` because the
Codex proxy zeroes them at startup.

---

## How It Works (subscription path)

Your refresh token is stored securely in the control plane and is never exposed to sandboxes. When a
sandbox needs to make an OpenAI API call, it requests a short-lived access token from the control
plane, which handles token refresh and rotation automatically. Only the temporary access token is
present inside the sandbox.

Credentials are scoped per repository, so different repos can use different OpenAI accounts. When an
API key takes precedence, none of this applies: no sentinel, no auth proxy plugin, and no token
refresh calls.

---

## Troubleshooting

### Model doesn't appear in the dropdown

Ensure your deployment is up to date. OpenAI model support requires the latest version of
Open-Inspect.

### Session fails to start with an OpenAI model

Verify that both `OPENAI_OAUTH_REFRESH_TOKEN` and `OPENAI_OAUTH_ACCOUNT_ID` are set in your
repository secrets (Settings page). The refresh token may have expired — repeat Step 1 to obtain
fresh credentials.

### "The usage limit has been reached"

The ChatGPT subscription behind `OPENAI_OAUTH_REFRESH_TOKEN` hit its Codex quota. Wait for the quota
window to reset, switch the session to a Claude model, or add an `OPENAI_API_KEY` secret
([Using an API key](#using-an-api-key)) to bill OpenAI usage per token instead.

### "Token refresh failed" errors

The OAuth refresh token may have been revoked or expired. Re-authenticate by repeating Step 1 and
updating the secrets in your Settings page.
