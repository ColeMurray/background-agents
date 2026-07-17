# Superserve Sandbox Provider

Open-Inspect can run coding sessions in Superserve Firecracker microVMs. The Cloudflare control
plane calls the Superserve REST API directly; no provider shim is deployed.

## MVP Capabilities

- Create a sandbox from an Open-Inspect runtime template.
- Explicitly launch the runtime bridge with the session environment after creation.
- Pause inactive sandboxes and activate them in place for later prompts.
- Recover with a fresh sandbox when an auto-deleted sandbox no longer exists.
- Expose code-server, terminal, and configured tunnel ports through Superserve preview URLs.
- Apply optional sandbox-wide egress rules and paused-sandbox auto-deletion.
- Run existing Open-Inspect cron and webhook automations in Superserve sandboxes without a second
  scheduler.

Superserve snapshots are intentionally not connected to Open-Inspect image prebuilds in this MVP.
The provider reports persistent resume support, but not filesystem snapshot/restore support.

## Configuration

Set the provider in `terraform/environments/production/terraform.tfvars`:

```hcl
sandbox_provider = "superserve"

superserve_api_url      = "https://api.superserve.ai"
superserve_api_key      = "ss_live_..."
superserve_sandbox_host = "sandbox.superserve.ai"

# Leave empty for a Terraform-managed Open-Inspect runtime template.
superserve_template = ""

# Optional: delete a sandbox after seven continuously paused days.
superserve_auto_delete_seconds = 604800
```

The API URL and sandbox host must belong to the same Superserve region. For example, the west-US
cell uses `https://api-usw.superserve.ai` and `usw-sandbox.superserve.ai`.

### Egress Policy

Superserve egress is open unless deny rules are configured. For a strict allowlist, allow every host
the runtime needs and deny all other IPv4 egress:

```hcl
superserve_network_allow_out = [
  "open-inspect-control-plane-example.workers.dev",
  "github.com",
  "api.github.com",
  "api.anthropic.com",
]
superserve_network_deny_out = ["0.0.0.0/0"]
```

Replace the control-plane hostname with the deployment's actual Worker/custom-domain hostname. Add
the SCM, model, package registry, and MCP hosts required by your workloads. An incomplete allowlist
can prevent the bridge from connecting or the agent from installing dependencies.

## Runtime Template

When `superserve_template = ""`, Terraform hashes the runtime and builder sources, creates a
deterministically named template, and passes its name to the control plane. The builder installs
OpenCode, Python dependencies, code-server, ttyd, agent-browser, GitHub CLI, and the Open-Inspect
sandbox runtime. It checks out the current Git commit from the checkout's `origin` remote (GitHub
SSH remotes are converted to HTTPS), so that repository and commit must be anonymously reachable
before `terraform apply` runs. Set `OPENINSPECT_RUNTIME_REPOSITORY` when manually building from a
different public source.

To build a template manually:

```bash
SUPERSERVE_API_URL="https://api.superserve.ai" \
SUPERSERVE_API_KEY="ss_live_..." \
SUPERSERVE_TEMPLATE="openinspect-runtime" \
npm run build:superserve-template
```

Then set `superserve_template = "openinspect-runtime"` so Terraform skips the managed build.

## Lifecycle

Creation sends the full session environment to Superserve, then calls the sandbox data plane's
`/exec` endpoint to start `python3 -m sandbox_runtime.entrypoint`. This explicit launch is required
because the template is a live snapshot and cannot start the bridge with per-session values baked at
template-build time.

Stopping maps to Superserve pause, preserving memory, processes, and files. Resume uses the
idempotent activate endpoint, obtains a fresh data-plane token, and checks for the runtime process
before starting it. This avoids duplicating a bridge that survived pause while still recovering if
the process exited.

## Security Boundary

Superserve's microVM boundary isolates each sandbox from the provider host and other sandboxes. The
current Open-Inspect runtime still places `SANDBOX_AUTH_TOKEN` and configured environment secrets in
the guest process environment. Code running inside the same sandbox can therefore attempt to read
those values. Treat this MVP as suitable for trusted repositories or workloads whose in-sandbox code
shares the agent's credential trust level.

Do not claim credential-safe execution of arbitrary hostile code until Open-Inspect models
Superserve stored-secret names and lifecycle explicitly, scopes SCM credentials for untrusted runs,
and separates the bridge identity from repository processes. Egress allowlisting materially reduces
exfiltration paths, but does not by itself make plaintext guest credentials inaccessible.

## Verification

1. Run `terraform apply` and confirm the Superserve template reaches `ready`.
2. Start an Open-Inspect session and confirm a Superserve sandbox becomes `active`.
3. Confirm the session reaches `Connected` and responds to a repository question.
4. Let the session become inactive and confirm the sandbox becomes `paused`.
5. Send another prompt and confirm the same provider sandbox activates without a duplicate runtime.
6. If using strict egress, inspect Superserve's network log for allowed control-plane, SCM, and
   model traffic and blocked unexpected destinations.
