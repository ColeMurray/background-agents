# Adding or Updating Models

All model definitions live in one file: **`packages/shared/src/models.ts`**. Anything else that
needs to know about models imports from there. Treat this file as the single source of truth — if
you only edit it in one place, that place is `models.ts`.

## What `packages/shared/src/models.ts` defines

| Export                   | Purpose                                                    |
| ------------------------ | ---------------------------------------------------------- |
| `VALID_MODELS`           | Every canonical `provider/model` id the system understands |
| `ValidModel`             | Union type derived from `VALID_MODELS`                     |
| `DEFAULT_MODEL`          | Fallback when nothing else is configured                   |
| `MODEL_REASONING_CONFIG` | Which reasoning efforts each model supports + the default  |
| `MODEL_OPTIONS`          | Display name + description, grouped by provider, for UI    |
| `DEFAULT_ENABLED_MODELS` | Subset enabled out-of-the-box for new installations        |
| `MODEL_ALIASES`          | User-friendly shortcuts (`opus`, `sonnet-4-6`, …)          |
| `normalizeModelId`       | Adds `anthropic/` / `openai/` prefix to bare ids           |
| `resolveModelAlias`      | Alias lookup + `normalizeModelId` in one call              |
| `isValidModel`           | Returns true if the (normalized) id is in `VALID_MODELS`   |

## Workflow: adding a new model

### 1. Add the canonical id

Edit `packages/shared/src/models.ts`:

1. Add the `provider/model` id to **`VALID_MODELS`**.
2. Add a **`MODEL_REASONING_CONFIG`** entry if the model supports reasoning efforts. Omit the entry
   for models that don't (they'll silently fall through `supportsReasoning`).
3. Add a **`MODEL_OPTIONS`** entry under the right provider group so it shows up in dropdowns.
   Include a short `description`.
4. If the model should ship enabled by default, add it to **`DEFAULT_ENABLED_MODELS`** as well.

### 2. (Optional) Update aliases

If the new model is the new "latest" for a family (e.g. you're shipping `claude-opus-4-8` as the
next Opus), update the family alias in **`MODEL_ALIASES`** so `model: opus` directives and
`model:opus` Linear labels start pointing at it:

```ts
opus: "anthropic/claude-opus-4-8",
```

Also add an explicit version alias so users can pin (`opus-4-8` → `anthropic/claude-opus-4-8`) when
they don't want the floating "latest".

You only need alias entries for IDs that `normalizeModelId` can't infer:

- `claude-*` and `gpt-*` bare ids work without an alias.
- Bare versions like `opus-4-8`, `sonnet-4-6` need an alias entry.
- Family shortcuts like `opus`, `sonnet`, `haiku` need an alias entry.

### 3. Rebuild shared and run the suite

```bash
npm run build -w @open-inspect/shared
npm run typecheck
npm test
```

Every other package consumes the shared package's built output, so the rebuild is mandatory before
typechecking the rest of the workspace.

### 4. (Optional) Change the deployed default

`DEFAULT_MODEL` in `packages/shared/src/models.ts` is the in-code fallback. Production deployments
override it via Terraform env bindings:

- `terraform/environments/production/workers-github.tf` — `DEFAULT_MODEL`
- `terraform/environments/production/workers-linear.tf` — `DEFAULT_MODEL`
- `terraform/environments/production/workers-slack.tf` — `DEFAULT_MODEL` and `CLASSIFICATION_MODEL`

Update those bindings only if you want the new model to be the live default for that bot. They're
independent of the in-code defaults so each bot can roll out at its own pace.

### 5. Things you do **not** need to edit

- Per-bot alias maps. There aren't any — both `github-bot` and `linear-bot` import
  `resolveModelAlias` from shared. If you find yourself adding a local `MODEL_ALIASES` constant in a
  bot, stop and put it in shared instead.
- The control-plane resolver — it just passes through whatever string it receives.
- The web UI — `MODEL_OPTIONS` is the only thing it reads, and dropdowns are generated from it.

## Workflow: removing a model

1. Delete the id from `VALID_MODELS`, `MODEL_REASONING_CONFIG`, `MODEL_OPTIONS`, and
   `DEFAULT_ENABLED_MODELS`.
2. Update any `MODEL_ALIASES` entry that pointed at it (either retarget to a newer model in the same
   family or remove the alias).
3. Search for hard-coded references and clean them up:
   ```bash
   git grep "<old-model-id>"
   ```
4. Existing D1/SQLite/KV rows with the old id will fall through to `DEFAULT_MODEL` via
   `getValidModelOrDefault` — no migration needed unless you want to backfill stored values.

## Where user-facing alias strings are accepted

- **GitHub bot `@mention` comments:** inline directive `@bot model: <alias> reasoning: <effort> …` —
  parsed in `packages/github-bot/src/inline-directive.ts`.
- **Linear issue labels:** `model:<alias>` — parsed in
  `packages/linear-bot/src/model-resolution.ts`.

Both call `resolveModelAlias` from shared, so any alias added to `MODEL_ALIASES` works in both
places automatically.
