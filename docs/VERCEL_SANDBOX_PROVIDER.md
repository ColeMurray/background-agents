# Vercel Sandbox Provider

Open-Inspect can use Vercel Sandboxes as the data-plane provider for coding sessions. The control
plane talks directly to the Vercel Sandbox REST API from Cloudflare Workers; there is no separate
Modal-style shim service for this provider.

## When to Use It

Use `sandbox_provider = "vercel"` when you want sandbox sessions to run in Vercel Sandboxes while
keeping the same Open-Inspect control plane and web app deployment flow. Vercel supports filesystem
snapshots, so Open-Inspect can restore a base runtime snapshot, create repo-specific snapshots, and
resume user sessions from saved filesystem state.

## Required Configuration

For Terraform variables, set:

```hcl
sandbox_provider          = "vercel"
vercel_sandbox_token      = "..."
vercel_sandbox_project_id = "prj_..."
# vercel_sandbox_team_id  = "team_..." # optional for team projects
```

For GitHub Actions based deployment, configure the matching repository secrets:

```text
SANDBOX_PROVIDER=vercel
VERCEL_SANDBOX_TOKEN
VERCEL_SANDBOX_PROJECT_ID
VERCEL_SANDBOX_TEAM_ID # optional
```

Optional runtime settings:

```text
VERCEL_SANDBOX_RUNTIME=node24
VERCEL_RUNTIME_REPO_URL=https://github.com/ColeMurray/background-agents.git
VERCEL_RUNTIME_REPO_REF=main
VERCEL_SNAPSHOT_EXPIRATION_MS=0
```

`VERCEL_SNAPSHOT_EXPIRATION_MS` applies to repo/session snapshots created at runtime. `0` means no
expiration. The managed base-runtime snapshot is created without expiration.

## Managed Base Runtime Snapshot

When the Terraform GitHub Actions apply job runs with `SANDBOX_PROVIDER=vercel`, it builds a fresh
base-runtime snapshot before `terraform apply`:

1. Create a temporary Vercel sandbox.
2. Run the Open-Inspect runtime bootstrap script inside that sandbox.
3. Clone `VERCEL_RUNTIME_REPO_URL` at `VERCEL_RUNTIME_REPO_REF`.
4. Install the sandbox runtime, OpenCode, code-server, ttyd, browser tooling, and credential helper.
5. Snapshot the prepared filesystem.
6. Stop the temporary sandbox.
7. Pass the generated snapshot ID into Terraform as `vercel_base_snapshot_id`.

The deployed control plane receives that value as `VERCEL_BASE_SNAPSHOT_ID`. Fresh Vercel sessions
start from this snapshot, so they do not need to reinstall the base runtime every time.

`vercel_base_snapshot_id` still exists as a manual fallback for local Terraform applies or emergency
pinning, but the normal CI path should generate it.

## Runtime Source

The runtime source is intentionally a repository/ref pair rather than files uploaded from the local
Terraform checkout. By default it uses:

```text
https://github.com/ColeMurray/background-agents.git
main
```

This keeps the public deploy path simple and makes the base snapshot reproducible from a Git ref. If
you need a private fork or pinned release branch, set `VERCEL_RUNTIME_REPO_URL` and
`VERCEL_RUNTIME_REPO_REF` in GitHub Actions secrets before running Terraform apply.

## Session Startup Sources

Vercel sessions choose their source in this order:

1. Repo image snapshot, when a repo-specific prebuild exists.
2. Managed base-runtime snapshot from `VERCEL_BASE_SNAPSHOT_ID`.
3. Fresh Vercel sandbox followed by runtime bootstrap, if no snapshot is configured.

Repo image snapshots still take precedence over the base runtime snapshot because they contain both
the base runtime and repository-specific setup work.

## Shutdown and Snapshots

Vercel sandboxes are explicitly stopped by Open-Inspect when they should no longer run:

- The temporary base-snapshot build sandbox is stopped after its snapshot is created.
- Inactive Vercel sessions are snapshotted and stopped by the lifecycle manager.
- Runtime-created snapshots use `VERCEL_SNAPSHOT_EXPIRATION_MS`; the base runtime snapshot does not
  expire by default.

Existing generated base snapshots are not automatically deleted. Treat them like deploy artifacts:
keep the current snapshot, and delete old snapshots manually if you need to reclaim quota.

## CPU and Memory

Open-Inspect does not currently send a Vercel `resources` setting when creating sandboxes. Vercel
therefore applies its default sandbox size.

At the time this provider was added, Vercel documented the default as `2` vCPUs with memory tied to
CPU at `2 GB` per vCPU, which gives the observed default of `2 vCPU / 4 GB RAM`. Vercel also
documents `1`, `2`, `4`, and `8` vCPU options for standard sandbox configuration, with larger
Enterprise configurations available separately.

If Open-Inspect needs to control this later, add a provider config value such as
`VERCEL_SANDBOX_VCPUS`, thread it into the Vercel create-sandbox request as `resources.vcpus`, and
let Vercel derive memory from that vCPU count.

References:

- [Vercel Sandbox pricing and limits](https://vercel.com/docs/vercel-sandbox/pricing)
- [Vercel Sandbox REST API](https://vercel.com/docs/vercel-sandbox)
- [Vercel Sandbox 32 vCPU / 64 GB RAM changelog](https://vercel.com/changelog/vercel-sandbox-now-supports-up-to-32-vcpu-64-gb-ram-configurations)
