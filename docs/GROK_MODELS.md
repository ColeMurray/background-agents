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
| `xai/grok-build-0.1` | Grok Build 0.1 | Not configurable  | N/A            |

Grok Build performs reasoning internally but does not accept a configurable reasoning effort.

The **xAI / SuperGrok** group is disabled by default. An administrator must enable it under
**Settings > Models** before it appears in session and integration model selectors.

---

## Setup

### Step 1: Obtain an xAI OAuth Refresh Token

Use OpenCode 1.17.18 or newer on a trusted local machine:

1. Install and launch [OpenCode](https://opencode.ai).
2. Run `/connect setup`.
3. Select **xAI Grok OAuth (SuperGrok Subscription)** and complete the browser login. For a remote
   machine, select the headless/device-code xAI option instead.
4. Open OpenCode's credential file:
   ```bash
   cat ~/.local/share/opencode/auth.json
   ```
5. In the `xai` entry, copy the `refresh` value.

Treat this value like a password. Do not copy the short-lived `access` value into Open-Inspect and
do not commit either value to a repository.

xAI refresh tokens rotate. After transferring the token, do not keep using the same xAI credential
entry in local OpenCode: a local refresh can rotate the token before Open-Inspect persists it.
Remove the local `xai` entry or reserve that login exclusively for Open-Inspect. If another client
rotates the token, repeat this step and replace the stored secret.

### Step 2: Store the Refresh Token

In the Open-Inspect web app, open **Settings > Secrets** and add:

| Secret name               | Value                                 |
| ------------------------- | ------------------------------------- |
| `XAI_OAUTH_REFRESH_TOKEN` | The `xai.refresh` value from OpenCode |

Choose the scope based on who should share the subscription:

| Scope       | Sessions that use it                                                               |
| ----------- | ---------------------------------------------------------------------------------- |
| Global      | Any session without a more specific managed xAI credential                         |
| Repository  | Sessions launched from that repository; overrides global                           |
| Environment | Sessions launched from that environment; overrides global and ignores repo secrets |

For an ad-hoc multi-repository session, managed OAuth credentials come from the primary repository
only, then fall back to global. A secondary repository cannot become the token rotation source.

### Step 3: Enable and Select Grok

1. Open **Settings > Models**.
2. Enable **Grok 4.5** or **Grok Build 0.1** under **xAI / SuperGrok**.
3. Create a new session or restart an existing sandbox.
4. Select the enabled Grok model and the desired reasoning effort.

---

## How Authentication Works

The OAuth refresh token stays in the encrypted control-plane secret store:

1. At sandbox creation, Open-Inspect removes xAI OAuth credentials from the generic environment and
   injects only the non-secret `XAI_OAUTH_MANAGED=1` marker.
2. The sandbox runtime writes an xAI OAuth sentinel to OpenCode's `auth.json` and installs the xAI
   auth proxy plugin.
3. The plugin calls the sandbox-authenticated `/sessions/:id/xai-token-refresh` broker.
4. The control plane returns a short-lived access token, caches it, and writes any rotated refresh
   token back to the same global, repository, or environment scope it came from.
5. The plugin replaces OpenCode's dummy authorization header with the short-lived bearer token.

The sandbox never receives `XAI_OAUTH_REFRESH_TOKEN`. Broker responses use
`Cache-Control: no-store`, and the endpoint rejects user and service credentials in favor of the
matching session's sandbox token.

---

## Deployment and Rollout

The xAI proxy plugin is part of `packages/sandbox-runtime`. After upgrading Open-Inspect, rebuild
the sandbox runtime image or provider snapshot before testing Grok. Existing images do not gain the
plugin merely because the control plane was deployed.

Before production rollout, run a staging session with an eligible SuperGrok account and verify:

- The selected Grok model is available to the account.
- A prompt succeeds at each enabled reasoning effort.
- A second prompt reuses or refreshes the brokered access token.
- A new sandbox can authenticate after token refresh without replacing the stored secret manually.
- Sandbox environment inspection does not reveal `XAI_OAUTH_REFRESH_TOKEN`.

---

## Troubleshooting

### Grok does not appear in the model selector

Enable **Grok 4.5** or **Grok Build 0.1** under **Settings > Models**. The xAI group is opt-in and
is not part of the default enabled model set.

### `XAI_OAUTH_REFRESH_TOKEN not configured`

Check the session target's secret scope. Environment sessions do not inherit repository secrets, and
multi-repository sessions use only the primary repository for managed OAuth credentials. Restart the
sandbox after changing secrets.

### `xAI token refresh failed: unauthorized` or `invalid_grant`

The refresh token was revoked, expired, or already rotated elsewhere. Repeat the local OpenCode
login and replace `XAI_OAUTH_REFRESH_TOKEN` in the same secret scope.

### `Model not found: xai/grok-4.5` or `xai/grok-build-0.1`

Rebuild the sandbox image so it includes the xAI auth proxy plugin and confirm the deployment uses
OpenCode 1.17.18 or newer.

### xAI rejects the model or account

Confirm that the authenticated account has an eligible SuperGrok subscription and that xAI currently
lists the selected model for that account. Entitlement failures cannot be corrected by Open-Inspect.
