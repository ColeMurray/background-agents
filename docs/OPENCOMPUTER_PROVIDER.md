# OpenComputer Sandbox Provider

Open-Inspect can use OpenComputer as the sandbox provider for coding sessions. The control plane
talks directly to the OpenComputer REST API from Cloudflare Workers; there is no Modal-style shim
service to deploy.

Use `sandbox_provider = "opencomputer"` when you want sessions to run in OpenComputer sandboxes
while keeping the same Open-Inspect control plane, web app, GitHub OAuth, and Slack/GitHub
integrations.

## v2 Migration Status

Issue [#2000](https://github.com/ColeMurray/background-agents/issues/2000) remains open until a
rebuilt managed template and production shutdown/restore canary have passed. The SDK builder now
uses `@opencomputer/sdk` v2, and the direct REST client sends `x-oc-sdk-version` to select the
active runtime. OpenComputer keeps the existing `/api` routes; changing the URL to `/v2` is not the
migration. The builder requires `endAt` on its verification sandbox before publishing the template
reference. An organization runtime pin can override version-based routing.

The managed image targets Amazon Linux 2023 on ARM64, as specified in the pinned upstream
[template documentation](https://github.com/diggerhq/opencomputer/blob/2a2462682589e9e327966a936ae0075528894a92/docs-sandbox/sandboxes/templates.mdx).
Image planning selects SHA-256-pinned ARM64 archives for Node, uv, agent-browser, code-server, ttyd,
Codex and Chrome. The existing amd64 pins remain unchanged. The old Chrome 152 pin has no Linux
ARM64 download in Google's release manifest; ARM64 uses Chrome for Testing 155.0.8059.79 instead.
The browser configuration follows the stable `/usr/local/bin/google-chrome` link. OpenComputer sets
`--no-sandbox --disable-dev-shm-usage` explicitly: the guest cannot elevate and agent-browser's
container detection does not identify this MicroVM. No browser emulation or unpinned browser
package-manager fallback is used.

Amazon Linux installation supports the provider's DNF without depending on DNF4's config-manager
flags. The OpenComputer image builds a small recording toolchain from pinned FFmpeg, x264 and libvpx
sources. Native image verification encodes H.264 MP4 and VP8 WebM files, the formats used by
agent-browser's recorder. The CI reference-image matrix includes native ARM64/Amazon Linux; it
complements the existing amd64 builds and does not replace a provider rebuild or production canary.

The
[pinned upstream migration guide](https://github.com/diggerhq/opencomputer/blob/2a2462682589e9e327966a936ae0075528894a92/docs-sandbox/migrating-from-v1.mdx)
also documents filesystem-only checkpoints, a hard host lifetime reported in `endAt`, and
unavailable checkpoint forking. The provider uses disk-only captures, creates a replacement from the
managed template, restores the checkpoint in place, and starts the runtime again. Hibernation does
not extend the host lifetime. Old v1 templates must be rebuilt; existing names alone do not
establish compatibility.

v2 sandbox commands run unprivileged and cannot elevate through `sudo`. Runtime launch uses the
Amazon Linux system CA bundle plus the provider's optional proxy CA in a user-writable bundle, and
logs to `/home/sandbox/.cache/openinspect/runtime.log` (also linked from
`/tmp/openinspect-runtime.log`). Image verification runs as the sandbox user.

Checkpoint archives contain `/home/sandbox` only. The managed image makes `/workspace` a symlink to
`/home/sandbox/workspace`, so repository state is captured without changing application paths.
Installations or data written outside that home at session runtime are not checkpointed; system
tools installed during the base image build are retained by the template. See the pinned upstream
[checkpoint implementation](https://github.com/diggerhq/opencomputer/blob/2a2462682589e9e327966a936ae0075528894a92/cmd/microvm-hooks/oc_workspace.go).

Production template rebuilding, a deployed session handshake and the production shutdown canary
remain unverified until run with provider credentials. Do not switch the default provider based only
on local contract results.

### Provider Canary

Once a compatible managed template has been built and verified, run the opt-in provider test with a
dedicated test account/template:

```bash
export OPENCOMPUTER_API_KEY="osb_..."
export OPENCOMPUTER_API_URL="https://app.opencomputer.dev/api"
export OPENCOMPUTER_TEMPLATE="<rebuilt-managed-template>"
OPENCOMPUTER_RUN_LIVE_TESTS=1 npm test -w @open-inspect/control-plane -- \
  src/sandbox/opencomputer-live.test.ts --maxWorkers=1
```

This allocates paid resources. It uses the real REST provider to create, checkpoint, preserve-stop,
restore, wake, and destroy sandboxes. It checks managed runtime smoke verification and sentinel
files in both `/workspace` and `/home/sandbox`, then deletes the canary checkpoint and sandboxes. It
supplies no model credentials and points the runtime at a loopback control-plane address. Cleanup
errors fail the test; inspect the provider account after any interrupted run.

The test is skipped unless explicitly enabled. It does not exercise the shutdown coordinator, a
deployed session's WebSocket handshake, or a production Terraform apply. Those acceptance checks
still require the production deployment and an actual session before changing the default provider.

## Configuration

Set these values in `terraform/environments/production/terraform.tfvars`:

```hcl
sandbox_provider = "opencomputer"

opencomputer_api_url = "https://app.opencomputer.dev/api"
opencomputer_api_key = "osb_..."

# Optional: use an existing OpenComputer template by name.
# Leave empty to let Terraform build and manage the OpenInspect runtime template.
opencomputer_template = ""
```

The OpenComputer provider also needs the normal Open-Inspect values such as Cloudflare, GitHub App,
Anthropic, and web app configuration. See [GETTING_STARTED.md](./GETTING_STARTED.md) for the full
deployment flow.

## Template Build

OpenComputer sandboxes boot from a declarative template that contains:

- the OpenInspect sandbox runtime
- OpenCode and the OpenCode plugin dependencies
- Python 3.12 runtime dependencies
- GitHub CLI and Git credential helpers
- browser/terminal support tools used by the agent runtime
- certificate and localhost bootstrap commands needed by the sandbox environment

There are two supported ways to provide this template.

### Terraform-Managed Template

This is the recommended path for a normal deployment.

Leave `opencomputer_template = ""`. When `sandbox_provider = "opencomputer"`, Terraform computes a
hash of the sandbox runtime and OpenComputer template builder source, builds a deterministic
template named like:

```text
openinspect-runtime-<source-hash-prefix>
```

and passes that template name to the deployed control plane as `OPENCOMPUTER_TEMPLATE`.

Run the deployment from the production Terraform directory:

```bash
cd terraform/environments/production
terraform init
terraform apply
```

Terraform rebuilds the managed template when relevant runtime or builder files change.

### Manual Template

Use this path when you want to build or test a template before wiring it into Terraform.

```bash
OPENCOMPUTER_API_URL="https://app.opencomputer.dev/api" \
OPENCOMPUTER_API_KEY="osb_..." \
OPENCOMPUTER_TEMPLATE="openinspect-runtime" \
npm run build:opencomputer-template
```

Then set the same template name in Terraform:

```hcl
sandbox_provider      = "opencomputer"
opencomputer_template = "openinspect-runtime"
```

When `opencomputer_template` is non-empty, Terraform skips the managed template build and uses that
exact template name.

## Runtime Behavior

The OpenComputer provider creates fresh sandboxes from the configured template. The sandbox starts
the OpenInspect runtime, which:

1. clones or syncs the selected GitHub repository
2. prepares repo-local OpenCode tools and skills
3. starts OpenCode inside the sandbox
4. starts the OpenInspect bridge process
5. streams agent events back through the control plane

OpenComputer owns sandbox hibernation and wake-up. Open-Inspect should not need to manually stop
OpenComputer sandboxes during normal operation.

## Required Secrets

Terraform passes these provider-level values to the control plane:

- `OPENCOMPUTER_API_URL`
- `OPENCOMPUTER_API_KEY`
- `OPENCOMPUTER_TEMPLATE`
- `ANTHROPIC_API_KEY` (optional — bound only when the deployment configured one)

The runtime also receives repository credentials from Open-Inspect for Git operations. If you use
additional model providers or custom agent tools, add those keys through Open-Inspect's secrets
settings. For example, Z.AI Coding Plan GLM models require `ZHIPU_API_KEY`. See
[SECRETS.md](./SECRETS.md).

## Verify

After `terraform apply`, verify:

1. The control plane is healthy:

   ```bash
   curl https://open-inspect-control-plane-<deployment_name>.<workers-subdomain>.workers.dev/health
   ```

2. The OpenComputer dashboard shows the OpenInspect template as ready.

3. Starting a session in the web app creates an OpenComputer sandbox and reaches `Connected`.

4. Inside the session, ask a simple repo question such as:

   ```text
   tell me about this repository
   ```

If a session starts but never produces agent output, check the control-plane Worker logs and the
OpenComputer sandbox logs for runtime startup, bridge connection, and OpenCode health events.

## Common Issues

### Template Was Not Built

If `opencomputer_template` is empty, Terraform should build the managed template during
`terraform apply`. If you set `opencomputer_template`, make sure that exact template name already
exists in OpenComputer and is ready.

### Wrong API URL

Use the API base URL, normally:

```text
https://app.opencomputer.dev/api
```

The builder normalizes a missing `/api` suffix, but the Terraform value should still be explicit.

### Missing Repository Access

Repository access still comes from the configured GitHub App installation. If the dashboard shows no
repositories or a sandbox cannot clone a repo, check the GitHub App installation permissions before
debugging OpenComputer.

### LLM/API Key Problems

The control plane passes `ANTHROPIC_API_KEY` for the default Claude models when the deployment
configured one; otherwise the key comes from Open-Inspect's secrets settings, which also override
it. If OpenCode reports a model or provider error, confirm the key for the selected model is
available through one of the two, and that the model is available for that account.
