# E2B Sandbox Provider

Open-Inspect can use [E2B](https://e2b.dev) as the sandbox provider for coding sessions. The control
plane talks directly to the E2B REST API from Cloudflare Workers — there is no separate service to
deploy for this provider; only the sandbox template image is built (by Terraform, or manually).

## When to Use It

Use `sandbox_provider = "e2b"` when you want sandbox sessions to run in E2B cloud sandboxes while
keeping the same Open-Inspect control plane, web app, GitHub OAuth, and Slack/GitHub integrations.
E2B sandboxes support pause/resume, so idle sessions are parked (not destroyed) and resumed on the
next prompt.

## Required Configuration

Set these values in `terraform/environments/production/terraform.tfvars`:

```hcl
sandbox_provider = "e2b"

e2b_api_key     = "e2b_..."             # from the E2B dashboard → API Keys
e2b_template_id = "open-inspect-sandbox" # template name to build/use

# Optional
# e2b_api_url                 = "https://api.e2b.app" # REST API base URL
# e2b_sandbox_timeout_seconds = 7200                  # sandbox TTL (default 2h)
# e2b_auto_pause              = true                   # pause (recoverable), not kill, on TTL lapse
```

For GitHub Actions-based deployment, configure the matching repository secrets:

```text
SANDBOX_PROVIDER=e2b
E2B_API_KEY
E2B_TEMPLATE_ID
E2B_API_URL                 # optional
E2B_SANDBOX_TIMEOUT_SECONDS # optional
E2B_AUTO_PAUSE              # optional
```

The E2B provider also needs the normal Open-Inspect values such as Cloudflare, GitHub App,
Anthropic, and web app configuration. See [GETTING_STARTED.md](./GETTING_STARTED.md) for the full
deployment flow.

> On the **Hobby** tier (~1h runtime cap), lower `e2b_sandbox_timeout_seconds` to `3300`.

## Template Build

E2B sandboxes boot from a **template** image that contains:

- the Open-Inspect sandbox runtime (`packages/sandbox-runtime`, staged into `/app`)
- OpenCode and the OpenCode plugin dependencies
- Python 3.12 and Node 22 runtimes
- `code-server`, `agent-browser`, and browser/terminal tooling used by the agent runtime
- GitHub CLI and a Git credential helper

The template is built programmatically with the E2B Template SDK. There are two supported paths.

### Terraform-Managed Template

This is the recommended path for a normal deployment. When `sandbox_provider = "e2b"`, the
`terraform/modules/e2b-infra` module hashes the relevant template and runtime source files under
`packages/e2b-infra` and `packages/sandbox-runtime/src`, and rebuilds the template on
`terraform apply` when they change.

```bash
cd terraform/environments/production
terraform init
terraform apply
```

### Manual Template

Use this path to build or test a template before wiring it into Terraform:

```bash
cd packages/e2b-infra
uv sync --frozen
export E2B_API_KEY=e2b_…
export E2B_TEMPLATE_ID=open-inspect-sandbox
uv run python build-template.py
```

Optional build knobs: `E2B_TEMPLATE_CPU` (default `2`), `E2B_TEMPLATE_MEM` MB (default `1024`) —
these apply to **manual** builds; Terraform-managed templates use the module's fixed defaults of **2
vCPU / 1024 MB**. See [`packages/e2b-infra/README.md`](../packages/e2b-infra/README.md) for details
on the template tooling and the launcher.

## Runtime Behavior

The E2B provider creates fresh sandboxes from the configured template. E2B runs the template's start
command once at build and resumes it per create, so it never sees per-session env. The launcher
(`oi-launch`) works around this:

1. waits for the control plane to drop the per-session env file (`/tmp/oi-session.env`) over envd
2. `exec`s the supervisor (`python -m sandbox_runtime.entrypoint`) with that env
3. the supervisor clones or syncs the selected repositories, starts OpenCode and code-server, and
   connects the Open-Inspect bridge back to the control plane
4. agent events stream back through the control plane

## Lifecycle: Pause and Resume

E2B's sandbox timeout is **not extended by in-sandbox agent activity** (Open-Inspect only resets it
when it resumes a sandbox), and E2B has no server-side idle-stop or auto-delete. Open-Inspect
therefore drives the lifecycle through the shared lifecycle manager, treating E2B stops as a
**resumable pause**:

- Idle sessions are **paused** after the shared inactivity timeout (default 10 minutes).
- When the TTL lapses, the sandbox created with `E2B_AUTO_PAUSE=true` **auto-pauses** (recoverable)
  rather than being killed.
- The next prompt **resumes** the paused sandbox in place (workspace state preserved); if E2B has
  since dropped it, the control plane spawns a fresh sandbox.
- Only sandboxes that fail before becoming usable — a spawn that never connects, or one whose
  session-env write fails — are **killed**, to avoid orphaning them.

Paused E2B sandboxes are not billed and are retained indefinitely, so pausing is the default
recoverable stop. `E2B_AUTO_PAUSE` controls the **TTL action** (pause vs kill when the timeout
lapses); the ~10-minute inactivity pause above is driven by the shared lifecycle manager and applies
regardless of that flag. Resume is always control-plane-driven — the next prompt reconnects the
sandbox through the lifecycle manager. E2B's provider-side auto-resume is deliberately **disabled**
so stray inbound traffic to an old tunnel can't wake a paused sandbox outside that state machine.

## Required Secrets

Terraform passes these provider-level values to the control plane:

- `E2B_API_KEY` — used for the E2B REST API **and** the code-server password HMAC, and to
  authenticate the template build
- `E2B_TEMPLATE_ID`
- `E2B_API_URL` (optional)
- `ANTHROPIC_API_KEY`

The runtime also receives repository credentials from Open-Inspect for Git operations. If you use
additional model providers or custom agent tools, add those keys through Open-Inspect's secrets
settings. See [SECRETS.md](./SECRETS.md).

## Verify

After `terraform apply`, verify:

1. The control plane is healthy:

   ```bash
   curl https://open-inspect-control-plane-<deployment_name>.<workers-subdomain>.workers.dev/health
   ```

2. The E2B dashboard shows the Open-Inspect template as built.

3. Starting a session in the web app creates an E2B sandbox and reaches `Connected`.

4. Inside the session, ask a simple repo question such as:

   ```text
   tell me about this repository
   ```

If a session starts but never produces agent output, check the control-plane Worker logs and the E2B
sandbox logs for runtime startup, bridge connection, and OpenCode health events.

## Common Issues

### Template Was Not Built

When `sandbox_provider = "e2b"`, Terraform builds the template during `terraform apply`, keyed on a
hash of the template and runtime source. To force a rebuild, change a hashed source file under
`packages/e2b-infra` or `packages/sandbox-runtime/src`. For a manual build, confirm
`E2B_TEMPLATE_ID` matches the name set in Terraform.

### Sandbox Times Out Too Soon

On plans with a short maximum lifetime, lower `e2b_sandbox_timeout_seconds`. With `E2B_AUTO_PAUSE`
enabled the sandbox pauses (recoverable) at the TTL rather than being lost.

### Missing Repository Access

Repository access still comes from the configured GitHub App installation. If the dashboard shows no
repositories or a sandbox cannot clone a repo, check the GitHub App installation permissions before
debugging E2B.

### LLM/API Key Problems

The control plane passes `ANTHROPIC_API_KEY` for the default Claude models. If OpenCode reports a
model or provider error, confirm the required provider key is available through Terraform or
Open-Inspect secrets and that the selected model is available for that account.

## References

- [E2B sandbox overview](https://e2b.dev/docs/sandbox)
- [E2B sandbox persistence (pause/resume)](https://e2b.dev/docs/sandbox/persistence)
- [E2B billing](https://e2b.dev/docs/billing)
- [E2B REST API](https://e2b.dev/docs/api-reference)
