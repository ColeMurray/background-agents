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

## Spilling over before the subscription runs out

A ChatGPT subscription that hits its Codex quota fails the session outright:
`Execution failed: The usage limit has been reached...`. Two optional secrets let a deployment keep
working on a per-token key, and cap how much of the subscription sandboxes may take in the first
place:

| Secret Name                       | Value                                                                     |
| --------------------------------- | ------------------------------------------------------------------------- |
| `OPENAI_API_KEY_FALLBACK`         | A platform API key, used only as a spillover                              |
| `OPENAI_SUBSCRIPTION_MAX_PERCENT` | Optional share of a rate-limit window sandboxes may consume (default 100) |

`OPENAI_API_KEY_FALLBACK` is deliberately a separate name from `OPENAI_API_KEY`: the latter selects
metered billing for the whole session and is stripped from sessions routed to a subscription, while
this one rides along unused until the subscription cannot answer. Set
`OPENAI_SUBSCRIPTION_MAX_PERCENT` to `80` to reserve the last fifth of each window for whoever else
uses that ChatGPT account.

A sandbox sends OpenAI traffic to the subscription until one of these happens, after which it uses
the fallback key for the rest of its life:

- usage is already at or above the ceiling when the sandbox starts. The percentage is read from
  `GET /backend-api/wham/usage`, which reports both windows without consuming any of them, so the
  first turn does not have to overshoot the ceiling to discover it
- a Codex response reports either window at or above the ceiling. On a successful response the
  in-flight reply is kept and only the next request moves over, because a started stream cannot be
  replayed
- Codex answers `429` with a quota signal: `x-codex-rate-limit-reached-type`, a usage-limit message,
  or a window at or above the ceiling. That request is retried on the fallback key immediately
- the control plane cannot mint a subscription access token at all (revoked or expired credentials)

A plain `429` with no quota signal is passed through untouched, so short-window throttling does not
spend money. Codex tracks a short (roughly 5-hour) and a weekly window, and the higher usage of the
two decides. An unparseable ceiling is ignored with a log line and treated as 100. If the usage
probe fails, the sandbox stays on the subscription and relies on response headers instead.

Every switch is logged in the sandbox logs as
`[codex-auth-plugin] spilling OpenAI traffic over to OPENAI_API_KEY_FALLBACK: <reason>`.

Two caveats: the latch lasts as long as the sandbox, so a session that spilled over stays on the key
even if the window resets under it, and OpenCode still reports OpenAI token costs as `0` because the
Codex proxy zeroes them at startup.

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

### "The usage limit has been reached"

The ChatGPT subscription hit its Codex quota. Wait for the window to reset, switch the session to
another provider's model, or configure a spillover key
([Spilling over](#spilling-over-before-the-subscription-runs-out)) so sessions continue on metered
billing.

### "Token refresh failed" errors

The OAuth refresh token may have been revoked or expired. Re-authenticate by repeating Step 1 and
updating the secrets in your Settings page.
