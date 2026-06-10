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

# Snapshot/runtime settings
# vercel_base_snapshot_id     = "snapshot_..." # optional manual override; Terraform skips managed builds when set
# vercel_sandbox_runtime        = "node24"
# vercel_snapshot_expiration_ms = 0
```

For GitHub Actions-based deployment, configure the matching repository secrets:

```text
SANDBOX_PROVIDER=vercel
VERCEL_SANDBOX_TOKEN
VERCEL_SANDBOX_PROJECT_ID
VERCEL_SANDBOX_TEAM_ID # optional
```

Optional GitHub Actions runtime settings:

```text
VERCEL_BASE_SNAPSHOT_ID # optional manual override; skips Terraform-managed snapshot builds
VERCEL_SANDBOX_RUNTIME=node24
VERCEL_SNAPSHOT_EXPIRATION_MS=0
VERCEL_SANDBOX_API_BASE_URL # optional advanced Sandbox API override
```

`VERCEL_SANDBOX_API_BASE_URL` is honored by Terraform and the control plane for advanced testing
against a non-default Sandbox API endpoint. Normal deployments should leave it unset.

`VERCEL_SNAPSHOT_EXPIRATION_MS` applies to repo/session snapshots created at runtime. `0` means no
expiration. The managed base-runtime snapshot is created without expiration, overriding Vercel's
default snapshot expiration for that deploy artifact.

## Managed Base Runtime Snapshot

When Terraform runs with `sandbox_provider = "vercel"`, the Vercel sandbox infrastructure module
builds a managed base-runtime snapshot from the local checkout:

1. Hash `packages/sandbox-runtime` and the Vercel bootstrap/builder files from `var.project_root`.
2. Create a temporary Vercel sandbox with a deterministic name derived from that hash.
3. Archive the checked-out `packages/sandbox-runtime` package and upload it into the temporary
   sandbox.
4. Install the sandbox runtime, OpenCode, code-server, ttyd, browser tooling, and credential helper.
5. Snapshot the prepared filesystem.
6. Stop the temporary sandbox.
7. Pass the deterministic snapshot name to the control plane as `VERCEL_BASE_SNAPSHOT_NAME`.

The deployed control plane resolves `VERCEL_BASE_SNAPSHOT_NAME` to the newest created Vercel
snapshot with that sandbox name, then starts fresh Vercel sessions from that snapshot. This keeps
fresh sessions from reinstalling the base runtime every time while keeping snapshot creation inside
the same Terraform apply path as the rest of the sandbox infrastructure.

`vercel_base_snapshot_id` still exists as a manual fallback for local Terraform applies or emergency
pinning. When it is set, Terraform skips the managed base snapshot build and the control plane uses
`VERCEL_BASE_SNAPSHOT_ID` directly. Vercel fresh sessions require either a repo image snapshot, a
manual base snapshot ID, or this managed base-runtime snapshot name.

## Session Startup Sources

Vercel sessions choose their source in this order:

1. Repo image snapshot, when a repo-specific prebuild exists.
2. Manual base-runtime snapshot from `VERCEL_BASE_SNAPSHOT_ID`, when configured.
3. Managed base-runtime snapshot resolved from `VERCEL_BASE_SNAPSHOT_NAME`.

Repo image snapshots still take precedence over the base runtime snapshot because they contain both
the base runtime and repository-specific setup work.

## Repo Image Build Callbacks

Vercel repo-image builds run inside a Vercel sandbox rather than a trusted Modal shim. The control
plane therefore does not pass `INTERNAL_CALLBACK_SECRET` into the build sandbox.

When a Vercel repo-image build is triggered, the control plane:

1. Generates a random callback token for that build only.
2. Stores only a hash of that token in D1 with the build row.
3. Creates the Vercel build sandbox and stores the expected Vercel session ID before launching the
   runtime entrypoint.
4. Passes the raw callback token, build ID, callback URL, and provider session ID to the runtime
   entrypoint command.
5. Consumes the token on the first success or failure callback, after verifying the build is still
   `building` and the callback's provider session ID matches the stored Vercel session.

On success, the runtime callback does not provide a provider image ID. It only reports that setup
finished. The control plane then snapshots the bound Vercel session and records that snapshot ID as
the repo image.

## Shutdown and Snapshots

Vercel sandboxes are explicitly stopped by Open-Inspect when they should no longer run:

- The temporary base-snapshot build sandbox is stopped after its snapshot is created.
- A Vercel repo-image build sandbox is stopped after the control plane snapshots the completed build
  session.
- Inactive Vercel sessions are snapshotted and stopped by the lifecycle manager.
- Runtime-created snapshots use `VERCEL_SNAPSHOT_EXPIRATION_MS`; the base runtime snapshot does not
  expire by default.

Existing generated base snapshots are not automatically deleted. Treat them like deploy artifacts:
keep the current snapshot, and delete old snapshots manually if you need to reclaim quota.

## CPU and Memory

Open-Inspect maps sandbox resource settings to Vercel's `resources.vcpus` setting when creating or
restoring sandboxes. `cpuCores` is treated as the requested vCPU count. `memoryMib` is treated as a
minimum memory request and converted using Vercel's documented `2 GB` per vCPU ratio. If both are
set, Open-Inspect uses enough vCPUs to satisfy both requests.

Vercel currently documents the unspecified default as `2 vCPU / 4 GB RAM`. Its pricing limits state
that each vCPU includes `2 GB` of memory, with a maximum of `8` vCPUs and `16 GB` memory per
sandbox. The `resources.vcpus` option can be used with `1`, `2`, `4`, or `8` vCPUs.

When a request falls between supported Vercel sizes, Open-Inspect rounds up to the next supported
vCPU size. If resource fields are unset or explicitly `null`, no `resources` setting is sent and
Vercel applies its provider default.

References:

- [Vercel Sandbox pricing and limits](https://vercel.com/docs/vercel-sandbox/pricing)
- [Vercel Sandbox REST API](https://vercel.com/docs/vercel-sandbox)
- [Vercel Sandbox 1 vCPU / 2 GB RAM changelog](https://vercel.com/changelog/vercel-sandbox-now-supports-1-vcpu-2-gb-configurations)
