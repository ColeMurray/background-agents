# Secrets Management

Open-Inspect lets you store environment variables — API keys, database URLs, credentials — and
inject them into every sandbox automatically. Secrets are encrypted at rest and never exposed to the
browser (only key names are visible in the UI).

---

## Quick Start

1. Open your Open-Inspect web app and go to **Settings**
2. The **Secrets** tab is selected by default
3. Use the scope dropdown at the top to choose **All Repositories (Global)** or a specific
   repository
4. Click **Add secret**, enter a key and value, then click **Save**

That's it — the next sandbox you launch will have the secret available as an environment variable.

---

## Global vs. Repository Secrets

| Scope          | Applies to        | Use case                                                              |
| -------------- | ----------------- | --------------------------------------------------------------------- |
| **Global**     | All repositories  | API keys shared across projects (`ANTHROPIC_API_KEY`, `DATABASE_URL`) |
| **Repository** | One specific repo | Repo-specific credentials (`STRIPE_SECRET_KEY`, `AWS_ACCESS_KEY_ID`)  |

**Precedence**: Repository secrets override global secrets with the same key. When viewing a
repository's secrets, inherited global keys are shown in a read-only section with a "Global" badge.
If you override a global key at the repo level, the global entry shows "(overridden by repo)."

### When to use global secrets

Use global secrets for keys that every session needs regardless of which repository it runs against.
The most common example:

| Key                 | Description                                                                                                                             |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY` | Required for Claude models when using the **Daytona** sandbox provider (Modal injects this automatically via its own secrets mechanism) |

> **Daytona users**: If you plan to use Claude models, you must add `ANTHROPIC_API_KEY` as a global
> secret after deploying. Without it, Claude sessions will fail with "Model not found." See
> [Getting Started — Daytona](GETTING_STARTED.md#daytona) for details.

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
| Key format                       | `[A-Za-z_][A-Za-z0-9_]*` (letters, digits, underscores) |

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

---

## Common Examples

| Key                          | Scope  | Purpose                                               |
| ---------------------------- | ------ | ----------------------------------------------------- |
| `ANTHROPIC_API_KEY`          | Global | Claude API access (required for Daytona provider)     |
| `OPENAI_OAUTH_REFRESH_TOKEN` | Repo   | OpenAI Codex access ([setup guide](OPENAI_MODELS.md)) |
| `OPENAI_OAUTH_ACCOUNT_ID`    | Repo   | OpenAI Codex access ([setup guide](OPENAI_MODELS.md)) |
| `DATABASE_URL`               | Repo   | Database connection string                            |
| `AWS_ACCESS_KEY_ID`          | Repo   | AWS credentials for a specific project                |
| `STRIPE_SECRET_KEY`          | Repo   | Stripe API key for a specific project                 |

---

## Troubleshooting

### "Model not found" errors (Daytona provider)

If you're using `sandbox_provider = "daytona"` with Claude models and see "Model not found" errors,
add your `ANTHROPIC_API_KEY` as a global secret in Settings. Unlike Modal, the Daytona provider does
not inject LLM API keys automatically.

### Secret not appearing in sandbox

1. Verify the secret is saved under the correct scope (global or the specific repo)
2. Check that the key isn't in the reserved keys list above
3. New secrets only apply to **new** sandboxes — restart your session to pick up changes

### Key name was auto-changed

Keys are automatically uppercased when saved. `my_api_key` becomes `MY_API_KEY`.
