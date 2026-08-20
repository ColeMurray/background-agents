# Secrets Management

Open-Inspect lets you store environment variables — API keys, database URLs, credentials — and make
them available to sessions automatically. Secrets are encrypted at rest and never exposed to the
browser (only key names are visible in the UI). Managed OAuth refresh tokens are brokered by the
control plane instead of being injected into sandboxes.

---

## Quick Start

1. Open your Open-Inspect web app and go to **Settings**
2. Navigate to the scope you want:
   - **Global or repository secrets**: the **Secrets** tab (selected by default) — use the scope
     dropdown at the top to choose **All Repositories (Global)** or a specific repository
   - **Environment secrets**: the **Environments** tab — open the environment and switch to its
     **Secrets** tab
3. Click **Add secret**, enter a key and value, then click **Save**

That's it — the next sandbox you launch from that scope will have the secret available as an
environment variable.

---

## Secret Scopes

| Scope           | Applies to                              | Use case                                                               |
| --------------- | --------------------------------------- | ---------------------------------------------------------------------- |
| **Global**      | All sessions                            | API keys shared across projects (`ANTHROPIC_API_KEY`, `ZHIPU_API_KEY`) |
| **Repository**  | Sessions launched from that repo        | Repo-specific credentials (`STRIPE_SECRET_KEY`, `AWS_ACCESS_KEY_ID`)   |
| **Environment** | Sessions launched from that environment | Credentials curated for a multi-repository environment (see below)     |

Global and repository secrets are managed under **Settings > Secrets**; environment secrets are
managed on the **Secrets** tab of each environment under **Settings > Environments**.

**Precedence**: Repository (or environment) secrets override global secrets with the same key. When
viewing a repository's secrets, inherited global keys are shown in a read-only section with a
"Global" badge. If you override a global key at the repo or environment level, the global entry
shows which scope overrode it.

### Which secrets a session receives

A session receives **global secrets plus its session target's secrets** — the session target is
whatever you picked when creating the session:

- **Single repository** (web picker, Slack, GitHub, Linear): global + that repository's secrets.
- **Environment**: global + that **environment's** secrets only. The repositories inside the
  environment do **not** contribute their repository secrets — environments are curated, so a key
  added to a repository never silently lands in every environment containing it. To reuse a
  repository secret, import it (below) or move it to global scope.
- **Ad-hoc multi-repository session** ("Multiple repositories" in the picker): global + each
  selected repository's secrets. On key collisions the **primary repository** (first in the list)
  wins.

The new-session picker states this disclosure for environment and multi-repository selections.

### Importing repository secrets into an environment

On an environment's **Secrets** tab you can import secrets from any repository that belongs to the
environment: pick the source repository, select the keys, and the values are copied
control-plane-side (never displayed). Imports are **copies** — if you later rotate the value on the
repository, re-import it or update the environment secret directly.

### When to use global secrets

Use global secrets for keys that every session needs regardless of which repository it runs against.
The most common example:

| Key                 | Description                                                                                                                                           |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY` | Required for Claude models when using the **Daytona** or **Vercel** sandbox provider (Modal injects this automatically via its own secrets mechanism) |
| `DEEPSEEK_API_KEY`  | Required for DeepSeek models with any sandbox provider                                                                                                |
| `ZHIPU_API_KEY`     | Required for Z.AI Coding Plan GLM models with any sandbox provider                                                                                    |

> **Daytona and Vercel sandbox users**: If you plan to use Claude models, you must add
> `ANTHROPIC_API_KEY` as a global secret after deploying. Without it, Claude sessions will fail with
> "Model not found." See [Getting Started](GETTING_STARTED.md) for details.

### When to use repository secrets

Use repository secrets for credentials that are specific to a single project — database connection
strings, third-party API keys, service account tokens, etc.

---

## Adding Secrets

### From the Settings page

1. Go to **Settings > Secrets**
2. Select a scope (global or a specific repository)
3. Click **Add secret**
4. Enter the key name (automatically uppercased) and value
5. Click **Save**

For environment secrets, go to **Settings > Environments**, open the environment, and use its
**Secrets** tab — the editor works the same way.

### Paste a `.env` file

You can paste a `.env`-formatted block (e.g., `KEY=value`) into any input field. Open-Inspect will
automatically parse it and populate multiple rows — useful for bulk imports.

### Updating a secret

Existing secret values are masked (`••••••••`). To update a value, type a new value into the field
and click **Save**. To keep the current value, leave the field empty.

### Deleting a secret

Click the delete button next to any secret row and confirm.

---

## Limits

| Constraint                       | Limit                                                   |
| -------------------------------- | ------------------------------------------------------- |
| Max secrets per scope            | 50                                                      |
| Max key length                   | 256 characters                                          |
| Max value size                   | 16 KB                                                   |
| Max total value size (per scope) | 64 KB                                                   |
| Max combined size per session    | 128 KB (global + session target, after merging)         |
| Key format                       | `[A-Za-z_][A-Za-z0-9_]*` (letters, digits, underscores) |

If the merged payload for a session (or an image build) exceeds the combined cap, the spawn fails
with an error that attributes bytes per contributing scope so you know what to trim. This mostly
matters for multi-repository sessions, where several repositories' secrets fold into one sandbox.

---

## Reserved Keys

Certain keys are reserved for system use and cannot be set as secrets:

`PYTHONUNBUFFERED`, `SANDBOX_ID`, `CONTROL_PLANE_URL`, `SANDBOX_AUTH_TOKEN`, `REPO_OWNER`,
`REPO_NAME`, `GITHUB_APP_TOKEN`, `SESSION_CONFIG`, `RESTORED_FROM_SNAPSHOT`,
`OPENCODE_CONFIG_CONTENT`, `PATH`, `HOME`, `USER`, `SHELL`, `TERM`, `PWD`, `LANG`

If you try to save a reserved key, the UI will show a validation error.

---

## Security

- Secrets are encrypted with **AES-256-GCM** before being stored in the database
- Values are **never returned by the API** after saving — only key names are visible
- Secrets are decrypted at sandbox creation time and injected as environment variables
- System variables (set by the control plane) always take precedence over user-defined secrets

OpenAI and xAI subscription credentials belong in **Settings > Provider Accounts**, not generic
Secrets. Their refresh and cached access tokens are encrypted with
`PROVIDER_ACCOUNTS_ENCRYPTION_KEY`, remain control-plane-only, and are never returned to the browser
or injected into sandboxes. A session pins an account ID, API-key mode, or legacy scoped-OAuth mode
and requests short-lived access through `POST /sessions/:id/provider-auth/:provider/access-token`.

Provider-account mode removes that provider's canonical API key from the sandbox environment so the
runtime cannot bypass the selected subscription. API-key mode continues to use ordinary global,
repository, or environment secrets.

### Legacy managed OAuth coexistence

Legacy scoped OpenAI/xAI OAuth remains supported for sessions pinned to it. Provider-account
defaults affect only sessions created afterward. **Settings > Provider Accounts** lists legacy key
locations across global, repository, and environment scopes:

```text
OPENAI_OAUTH_REFRESH_TOKEN
OPENAI_OAUTH_ACCESS_TOKEN
OPENAI_OAUTH_ACCESS_TOKEN_EXPIRES_AT
OPENAI_OAUTH_ACCOUNT_ID
XAI_OAUTH_REFRESH_TOKEN
XAI_OAUTH_ACCESS_TOKEN
XAI_OAUTH_ACCESS_TOKEN_EXPIRES_AT
```

Do not reuse the same rotating refresh token in both systems. Operators may remove legacy keys once
the legacy-bound sessions that depend on them are no longer needed.

### Secrets and prebuilt images

Image builds (repository images and environment images) run your `.openinspect/setup.sh` with the
same secrets a session would get. Anything the script **persists to disk** — an `.npmrc`, a `.env`
file, a downloaded credential — is captured in the image and re-served to every session that boots
from it, even after you rotate the secret. Two guidelines:

- **Avoid writing long-lived secrets to disk in `setup.sh`.** Read them from the environment at
  runtime (they are re-injected fresh on every session) instead of baking them into files.
- **Environment-secret changes invalidate prebuilt images automatically**: saving an environment's
  secrets supersedes its existing ready image and triggers a rebuild, so a revoked value cannot keep
  serving from an old image. Rotating **repository or global** secrets does _not_ invalidate images
  — stale on-disk material persists until the next commit-triggered rebuild, which is another reason
  to keep secrets out of the image filesystem.

---

## Common Examples

| Key                 | Scope  | Purpose                                                      |
| ------------------- | ------ | ------------------------------------------------------------ |
| `ANTHROPIC_API_KEY` | Global | Claude API access (required for Daytona or Vercel sandboxes) |
| `OPENAI_API_KEY`    | Global | OpenAI API access when a session selects API-key mode        |
| `XAI_API_KEY`       | Global | xAI API access when a session selects API-key mode           |
| `DEEPSEEK_API_KEY`  | Global | DeepSeek API access                                          |
| `ZHIPU_API_KEY`     | Global | Z.AI Coding Plan GLM access                                  |
| `DATABASE_URL`      | Repo   | Database connection string                                   |
| `AWS_ACCESS_KEY_ID` | Repo   | AWS credentials for a specific project                       |
| `STRIPE_SECRET_KEY` | Repo   | Stripe API key for a specific project                        |

---

## Troubleshooting

### "Model not found" errors

If you see "Model not found" errors, verify the selected provider authentication mode first. For
provider-account mode, verify the account and model entitlement. For API-key mode, add the required
key to the session's secret scope. OpenAI uses `OPENAI_API_KEY`; xAI uses `XAI_API_KEY`; Claude on
Daytona or Vercel uses `ANTHROPIC_API_KEY`; DeepSeek uses `DEEPSEEK_API_KEY`; Z.AI Coding Plan uses
`ZHIPU_API_KEY`. For subscription authentication, follow the provider-account setup guidance in
[OpenAI models](OPENAI_MODELS.md) or [Grok models](GROK_MODELS.md).

### Secret not appearing in sandbox

1. Verify the secret is saved under the correct scope (global, the specific repo, or the
   environment)
2. Check that the key isn't in the reserved keys list above
3. New secrets only apply to **new** sandboxes — restart your session to pick up changes
4. For sessions launched from an **environment**: repository secrets do not flow in. Add the key to
   the environment (or import it from the repository on the environment's Secrets tab).

### Key name was auto-changed

Keys are automatically uppercased when saved. `my_api_key` becomes `MY_API_KEY`.
