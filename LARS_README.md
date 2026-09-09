# LARS_README — Operating notes for this fork

Personal notes on running Open-Inspect at https://agents.bandcizer.io. Not a contribution doc.

## Deployment

The Vercel project has **no GitHub integration** (`terraform/environments/production/web-vercel.tf`
line 13 — `# No git_repository - deploy via CLI/CI instead of auto-deploy on push`). Pushing to
`main` does **not** redeploy the web app.

To deploy:

```bash
export VERCEL_TOKEN=vcp_...
./scripts/deploy-web.sh
```

The script reads `web_app_project_id` from terraform output and `vercel_team_id` from
`terraform.tfvars`, then runs `vercel deploy --prod` from the repo root.

CI workflows do not run on this fork (it's a fork — GitHub Actions disabled by default). Everything
is manual:

1. Edit code and Terraform config
2. `cd terraform/environments/production && terraform apply` (deploys workers, Modal, updates Vercel
   env vars)
3. `./scripts/deploy-web.sh` (deploys the Next.js web app)

## Allowed users

`terraform/environments/production/terraform.tfvars` → `allowed_users = "LarsBuur,timpihlbang"`.
Edit and re-apply Terraform to change. The tfvars file is gitignored.

## Branding

`terraform.tfvars`:

```hcl
app_name       = "R2"
app_short_name = "R2"
```

These propagate via the `APP_NAME` / `APP_SHORT_NAME` Terraform variables (added upstream in #594,
#597) to the web UI (`NEXT_PUBLIC_APP_NAME`), Slack bot bindings, Linear bot, PR body footers, and
outbound `User-Agent` headers. To change the brand: edit tfvars, `terraform apply`, then
`./scripts/deploy-web.sh`.

## Upstream sync

Origin = `LarsBuur/background-agents` (fork). Upstream = `ColeMurray/background-agents`.

```bash
git fetch upstream
git merge upstream/main
# resolve conflicts (typically in terraform/environments/production/*, slack-bot/src/index.ts)
git push origin main
./scripts/deploy-web.sh
cd terraform/environments/production && terraform apply
```

Pre-commit hook (lint-staged → prettier/eslint) OOMs on large merges (157 files). For merge commits,
use `git commit --no-verify` — the upstream code is already linted in upstream CI.

## Why a deploy never auto-runs

Two things to keep separate:

- **Terraform** updates _which_ Vercel environment variables exist on the project (`APP_NAME`,
  `ALLOWED_USERS`, etc.). Updating env vars in Vercel does **not** trigger a redeploy on its own.
- **Vercel deploy** rebuilds the app with the current env-var values.

After every change to env vars or app code, you need _both_ `terraform apply` _and_
`./scripts/deploy-web.sh`.

## Modal deploy gotcha (resolved)

If `terraform/modules/modal-app/scripts/deploy.sh` fails with
`ModuleNotFoundError: No module named 'pydantic'` or `No module named 'sandbox_runtime'`:

The `.venv` at `packages/modal-infra/.venv` is stale — most likely because the repo was moved on
disk (`~/Documents/background-agents` → `~/code/background-agents`). uv's shebang/`.pth` files
inside the venv still point at the old path.

Fix:

```bash
cd packages/modal-infra
rm -rf .venv
uv sync --frozen
```

Then re-run `terraform apply`.

The earlier PYTHONPATH workaround in `deploy.sh` was treating the symptom; it has since been
reverted.

## How agent sessions actually work (the 33-minute gotcha)

**The agent's conversation history is NOT stored in the Open-Inspect session Durable Object.**

The DO stores the _event stream_ (chat transcript) only for displaying in the web UI. The agent's
actual conversation context lives inside the coding agent (OpenCode) running inside the Modal
sandbox.

`packages/sandbox-runtime/src/sandbox_runtime/bridge.py:187` —

```python
self.opencode_session_id: str | None = None
# cached at: tempfile.gettempdir() / "opencode-session-id"
```

When a new prompt arrives and `opencode_session_id is None`, the bridge creates a brand-new OpenCode
session with zero history.

### The failure mode

1. You open `https://agents.bandcizer.io/session/<id>`, agent does work, edits files in the sandbox.
2. "Execution complete." Sandbox idle.
3. After **10 minutes** (`SANDBOX_INACTIVITY_TIMEOUT_MS = 600000` in
   `packages/control-plane/src/types.ts:92`), Modal kills the sandbox. Sandbox FS is destroyed —
   that takes:
   - Your uncommitted file edits
   - The OpenCode session ID (lives in tmpfs)
   - The OpenCode message log (lives in sandbox FS)
4. You come back to the same URL hours later, type a follow-up. Web UI looks continuous because the
   _transcript_ survived in the DO.
5. Control plane spawns a **fresh sandbox**, fresh git clone, fresh bridge.
   `opencode_session_id = None`. New OpenCode session = zero history.
6. `next dev` regenerates `next-env.d.ts` in the new sandbox — this is _the only_ diff the new agent
   sees.
7. You ask it to PR your earlier work. It PRs `next-env.d.ts`.

### Mitigations

**Behavioral (no code change):**

- Bump `SANDBOX_INACTIVITY_TIMEOUT_MS` to 1h+ for the control-plane worker if your work has pauses.
- When you return to a session after a long pause, first ask the agent to `git status` and show the
  working tree. If it's clean and you expected diffs, the sandbox was reaped — recover via `git log`
  / `git reflog` rather than re-prompting.
- Tell the agent in `CLAUDE.md` / `AGENTS.md` to commit WIP after each meaningful step before
  reporting done.

**Structural (TODO if this keeps biting):**

1. **WIP commit on sandbox shutdown** — easiest, biggest win. In the lifecycle manager's
   idle-timeout path: `git add -A && git commit -m "wip(<session>)"` to a session-scoped branch. On
   respawn: `git checkout` that branch. Solves the lost-file-edits half. ~30 lines.

2. **Replay-from-DO** — on respawn, fetch the recent N user/assistant messages from the session DO
   and feed them as a synthetic conversation seed to the new OpenCode session. Loses tool calls but
   gives the agent some context.

3. **Persist OpenCode session storage to R2** — bigger lift. Would need to upload OpenCode's storage
   dir before shutdown and restore it on respawn.

Removed upstream: there used to be a `SnapshotStore` in modal-infra that captured sandbox state, but
it was deleted in commit `70f071b` ("remove unused Modal volume and dead SnapshotStore registry").
Don't try to revive it — better to use the simpler git-WIP-commit approach above.

## Useful IDs and URLs

- Web URL: https://agents.bandcizer.io
- Control plane: https://open-inspect-control-plane-bandcizer.workers.dev
- Modal app: `open-inspect` (workspace `larsbuur`)
- Modal health: https://larsbuur--open-inspect-api-health.modal.run
- Vercel project ID: `prj_if51KH58cyGwwzswRhZhoyXFSekU`
- Vercel team ID: `team_b2ot2RHJh1f2fxuwLRt43m3O`

Verification commands (also in `terraform output verification_commands`):

```bash
curl https://open-inspect-control-plane-bandcizer.workers.dev/health
curl https://larsbuur--open-inspect-api-health.modal.run
curl https://agents.bandcizer.io
curl https://open-inspect-control-plane-bandcizer.workers.dev/sessions  # expect 401
```

## Local scratch files

- `notes.txt`, `notes2.md` — gitignored, contain secrets. Do **not** ever commit. Rotate anything in
  them if the file leaves your machine.
- `terraform.tfvars` — gitignored, contains all production secrets. Backed by the values in
  `notes.txt`.
