# OpenComputer Sandbox Provider

Open-Inspect can use OpenComputer as the sandbox provider for coding sessions. The control plane
talks directly to the OpenComputer REST API from Cloudflare Workers; there is no Modal-style shim
service to deploy.

Use `sandbox_provider = "opencomputer"` when you want sessions to run in OpenComputer sandboxes
while keeping the same Open-Inspect control plane, web app, GitHub OAuth, and Slack/GitHub
integrations.

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

The control plane passes `ANTHROPIC_API_KEY` for the default Claude models. If OpenCode reports a
model or provider error, confirm that the key is present in Terraform and that the selected model is
available for that account.
