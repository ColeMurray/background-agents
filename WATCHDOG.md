# Watchdog — Open-Inspect Operations

Internal notes for operating Watchdog's Open-Inspect deployment. This is a fork of
[ColeMurray/background-agents](https://github.com/ColeMurray/background-agents); see the upstream
README for the full architecture overview.

## Live URLs

| Service       | URL                                                                 |
| ------------- | ------------------------------------------------------------------- |
| Web app       | https://open-inspect-web-watchdog.watchdog-no.workers.dev           |
| Control plane | https://open-inspect-control-plane-watchdog.watchdog-no.workers.dev |
| Slack bot     | https://open-inspect-slack-bot-watchdog.watchdog-no.workers.dev     |
| GitHub bot    | https://open-inspect-github-bot-watchdog.watchdog-no.workers.dev    |
| Modal API     | https://watchdog--open-inspect-api-health.modal.run                 |

## Deployment identifiers

- `deployment_name`: `watchdog`
- Cloudflare account ID: `ad4807eb564afdbe8c4f2d5684f8a519`
- Cloudflare workers subdomain: `watchdog-no` (i.e. `*.watchdog-no.workers.dev`)
- Modal workspace: `watchdog`
- GitHub App:
  [Anton Watchdog](https://github.com/organizations/watchdog-no/settings/apps/anton-watchdog) (ID
  `3073401`, slug `anton-watchdog[bot]`)
- Slack App: ID `A0AKYG6D091`, display name `Anton`
- Web platform: **Cloudflare Workers** (via OpenNext) — not Vercel

## Terraform state

- Backend: Cloudflare R2, bucket `open-inspect-watchdog-tf-state` (default jurisdiction, EU-region)
- Endpoint: `https://ad4807eb564afdbe8c4f2d5684f8a519.r2.cloudflarestorage.com`
- Backend config: `terraform/environments/production/backend.tfvars` (gitignored)
- Variables: `terraform/environments/production/terraform.tfvars` (gitignored)

## Access control

| Mechanism                | Value         |
| ------------------------ | ------------- |
| `allowed_users`          | `hreiten`     |
| `allowed_email_domains`  | `watchdog.no` |
| `unsafe_allow_all_users` | `false`       |

To onboard a teammate: add their GitHub username to `allowed_users` in `terraform.tfvars`, then
`terraform apply`. The `watchdog.no` domain check covers anyone whose primary GitHub email is public
on watchdog.no — those users don't need a username entry.

## Operating the deployment

### Local apply (after editing `terraform.tfvars`)

```sh
cd terraform/environments/production
npm run build -w @open-inspect/control-plane -w @open-inspect/slack-bot -w @open-inspect/github-bot
terraform apply
```

### CI/CD

GitHub Actions auto-deploys on push to `main` via `.github/workflows/terraform.yml`. All required
secrets (32 of them) are stored as repository secrets in `watchdog-no/background-agents`; refresh
them via `gh secret set NAME --body 'value'` if any of the underlying credentials rotate.

### Post-deploy steps for new bot integrations

If the Slack/GitHub webhook URLs ever change (e.g. deployment_name rename), re-verify them:

- Slack: [Event Subscriptions](https://api.slack.com/apps/A0AKYG6D091/event-subscriptions) Request
  URL
- Slack: [Interactivity](https://api.slack.com/apps/A0AKYG6D091/interactive-messages) Request URL
- GitHub:
  [Webhook config](https://github.com/organizations/watchdog-no/settings/apps/anton-watchdog) (URL +
  secret)

## Adding a new repo

Each repo Watchdog wants the agent to work on must:

1. Be in the GitHub App's installed repository list — see
   https://github.com/organizations/watchdog-no/settings/installations/115824880 → "Configure".
   Either pick "All repositories" once (recommended) or add per-repo.
2. Have repo secrets loaded via the web app: Settings → Secrets → select repo scope → paste `.env`
   blob. See [docs/SECRETS.md](docs/SECRETS.md).
3. Optionally have `.openinspect/setup.sh` and `.openinspect/start.sh` if it needs services
   (Postgres, S3-compatible object store, etc.) running inside the sandbox. See
   `packages/sandbox-runtime/src/sandbox_runtime/entrypoint.py` lines 1095+ for the hook contract.
4. Optionally enable **pre-built images** at
   https://open-inspect-web-watchdog.watchdog-no.workers.dev/settings → Images, so fresh sessions
   restore from a snapshot in seconds rather than re-running setup.

## Watchdog-specific customizations vs upstream

The only diffs we maintain on top of `ColeMurray/background-agents` are this `WATCHDOG.md` file and
the gitignored Terraform variables (`terraform.tfvars`, `backend.tfvars`). All per-repo dev setup
(Postgres, RustFS object store, migrations, seeds) lives in each Watchdog repo's
`.openinspect/setup.sh` and `.openinspect/start.sh` hooks — see e.g.
[watchdog-monorepo PR #545](https://github.com/watchdog-no/watchdog-monorepo/pull/545).

To pull updates from upstream:

```sh
git fetch upstream
git merge upstream/main
```

## Related

- Watchdog monorepo native local dev refactor:
  [PR #545](https://github.com/watchdog-no/watchdog-monorepo/pull/545) (uses Postgres 17 + RustFS
  for the storage layer)
- Upstream architecture docs: [docs/HOW_IT_WORKS.md](docs/HOW_IT_WORKS.md)
- Repo secrets model: [docs/SECRETS.md](docs/SECRETS.md)
- Pre-built images: [docs/IMAGE_PREBUILD.md](docs/IMAGE_PREBUILD.md)
