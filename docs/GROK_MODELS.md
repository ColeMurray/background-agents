# Using Grok with a SuperGrok Subscription

Open-Inspect supports xAI's Grok models through a SuperGrok subscription. The control plane manages
the durable OAuth refresh token and gives each sandbox only a short-lived access token.

> **Note**: SuperGrok availability and model entitlement are controlled by xAI. Confirm that the
> account you authenticate can use the selected model before rolling it out broadly.

---

## Supported Models

| Model ID             | Display name   | Reasoning efforts | Default effort |
| -------------------- | -------------- | ----------------- | -------------- |
| `xai/grok-4.5`       | Grok 4.5       | low, medium, high | high           |
| `xai/grok-4.6`       | Grok 4.6       | low, medium, high | high           |
| `xai/grok-build-0.1` | Grok Build 0.1 | Not configurable  | N/A            |

Grok Build performs reasoning internally but does not accept a configurable reasoning effort.

The **xAI / SuperGrok** group is disabled by default. An administrator must enable it under
**Settings > Models** before it appears in session and integration model selectors.

---

## Setup

### Step 1: Connect SuperGrok

1. Open **Settings > Provider Accounts**.
2. Choose **Add account > SuperGrok**.
3. Open the xAI device authorization page and approve access with the displayed code.
4. Keep the dialog open until Open-Inspect confirms the connection.

Open-Inspect creates the account as **SuperGrok account** by default. Use **Rename** afterward if
you need to distinguish multiple subscriptions.

The refresh token is returned directly to the control plane and encrypted there. It is never shown
in the browser or copied through the sandbox. Provider accounts are installation-wide and available
to every admitted user in the deployment.

### Step 2: Configure Defaults

Choose an xAI **Default account** in **Settings > Provider Accounts**. Set **Unattended mode** to
**Use default account** for Slack, GitHub, Linear, and unpinned automation runs to use SuperGrok, or
choose **Use API key** to retain the metered API-key path for unattended launches.

Defaults affect newly created sessions only. Existing sessions keep their pinned provider-account,
API-key, or `legacy_scoped_oauth` mode. When a new session has no explicit selection or xAI default,
it also persists `legacy_scoped_oauth`: a resolved legacy refresh token uses the managed broker,
while its absence leaves `XAI_API_KEY` available as the compatibility fallback.

### Step 3: Enable and Select Grok

1. Open **Settings > Models**.
2. Enable **Grok 4.6**, **Grok 4.5**, or **Grok Build 0.1** under **xAI / SuperGrok**.
3. Create a new session.
4. Select the enabled Grok model and desired reasoning effort.
5. Use **xAI authentication** to follow provider policy, select a specific account, or choose **Use
   API key**.

Automation editors expose xAI authentication independently of the configured model. Leave it on
**Use defaults when each run starts**, or pin a specific account or API-key mode for future runs.

---

## How Authentication Works

The provider-account OAuth refresh token stays in the encrypted credential store:

1. Session creation pins a concrete xAI provider account, API-key mode, or legacy scoped-OAuth mode.
2. In account mode, Open-Inspect removes `XAI_API_KEY` and legacy xAI OAuth fields from the sandbox
   environment and injects only the non-secret `XAI_OAUTH_MANAGED=1` marker.
3. The sandbox runtime writes an xAI OAuth sentinel to OpenCode's `auth.json` and installs the xAI
   auth proxy plugin.
4. The plugin calls `POST /sessions/:id/provider-auth/xai/access-token` with the session's sandbox
   credential.
5. The control plane returns a short-lived access token and atomically persists rotated account
   credentials.
6. The plugin replaces OpenCode's dummy authorization header with the short-lived bearer token.

For a `legacy_scoped_oauth` binding, the generic broker delegates to the legacy scoped refresh path.
If the resolved secrets contain no legacy xAI refresh token, sandbox preparation leaves
`XAI_API_KEY` available as the compatibility fallback instead.

The sandbox never receives the refresh token. Broker responses use `Cache-Control: no-store`, and
the endpoint rejects user and service credentials in favor of the matching session's sandbox token.

---

## Deployment and Rollout

The provider-account xAI proxy plugin is part of `packages/sandbox-runtime`. Before rollout, rebuild
**every** sandbox runtime image, template, and provider snapshot. Existing images do not gain the
generic provider-auth endpoint merely because the control plane was deployed.

Before production rollout, run a staging session with an eligible SuperGrok account and verify:

- The selected Grok model is available to the account.
- A prompt succeeds at each enabled reasoning effort.
- A second prompt reuses or refreshes the brokered access token.
- A new sandbox can authenticate after token refresh without reconnecting the account manually.
- Sandbox environment inspection reveals neither the refresh token nor `XAI_API_KEY` in account
  mode.

Legacy scoped OAuth continues to work alongside provider accounts. Set an xAI default when new
sessions should use the connected account; existing sessions keep their pinned authentication. The
settings page lists legacy key locations so operators can remove them after legacy-bound sessions
are no longer needed. See [Using OpenAI Models](OPENAI_MODELS.md#deployment-and-coexistence).

---

## Troubleshooting

### Grok does not appear in the model selector

Enable **Grok 4.6**, **Grok 4.5**, or **Grok Build 0.1** under **Settings > Models**. The xAI group
is opt-in and is not part of the default enabled model set.

### Session uses API-key mode unexpectedly

Inspect the session or automation authentication selector and verify the xAI default and unattended
mode. Without a default or explicit choice, new sessions preserve legacy scoped behavior.

### `xAI token refresh failed: unauthorized` or `invalid_grant`

The refresh token was revoked, expired, or already rotated elsewhere. Use **Reconnect** on the
provider account and complete xAI device authorization again.

### `Model not found: xai/grok-4.6`, `xai/grok-4.5`, or `xai/grok-build-0.1`

Rebuild the sandbox image so it includes the xAI auth proxy plugin and confirm the deployment uses
OpenCode 1.17.18 or newer.

### xAI rejects the model or account

Confirm that the authenticated account has an eligible SuperGrok subscription and that xAI currently
lists the selected model for that account. Entitlement failures cannot be corrected by Open-Inspect.
