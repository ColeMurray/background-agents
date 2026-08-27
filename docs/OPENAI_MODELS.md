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

A sandbox sends OpenAI traffic to the subscription until one of these happens, then latches to a
successful fallback path for the rest of its life:

- when `OPENAI_SUBSCRIPTION_MAX_PERCENT` is below `100`, usage is already at or above that ceiling
  before the first turn. The percentage comes from `GET /backend-api/wham/usage`, which reports both
  windows without consuming either
- a Codex response reports either window at or above the ceiling. On a successful response the
  in-flight reply is kept and only the next request moves over, because a started stream cannot be
  replayed
- Codex answers `429` with a quota signal: a recognized primary/secondary
  `x-codex-rate-limit-reached-type`, a specific usage-limit-reached message, or a window at or above
  the ceiling. That request is retried on the fallback key immediately
- the control plane reports that the subscription credential is unusable or requires reconnection.
  Sandbox-auth, transient broker, network, timeout, configuration, and storage failures do not spend
  the fallback key

A plain `429` with no quota signal is passed through untouched, so short-window throttling does not
spend money. Codex tracks a short (roughly 5-hour) and a weekly window, and the higher usage of the
two decides. An unparseable ceiling is ignored with a log line and treated as 100. If the usage
probe fails, the sandbox stays on the subscription and relies on response headers instead.

`gpt-5.3-codex-spark` is subscription-only, so its platform fallback uses `gpt-5.3-codex`. Other
allowed models are sent unchanged. If the platform rejects a fallback request, the latch is cleared
and the next turn retries the subscription instead of remaining on a permanently failing paid path.

Every switch is logged in the sandbox logs as
`[codex-auth-plugin] spilling OpenAI traffic over to OPENAI_API_KEY_FALLBACK: <reason>`.

One caveat: after a successful spillover, the latch lasts as long as the sandbox even if the
subscription window resets under it. OpenCode also reports OpenAI token costs as `0` because the
Codex proxy zeroes them at startup.

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

### "The usage limit has been reached"

The ChatGPT subscription hit its Codex quota. Wait for the window to reset, switch the session to
another provider's model, or configure a spillover key
([Spilling over](#spilling-over-before-the-subscription-runs-out)) so sessions continue on metered
billing.

### "Token refresh failed" errors

The OAuth grant may have been revoked, expired, or rotated elsewhere. Use **Reconnect** on the
existing account and complete the same device authorization flow. Reconnect preserves the account's
display name and must authenticate the same OpenAI account identity; connect a new provider account
if the identity changed.
