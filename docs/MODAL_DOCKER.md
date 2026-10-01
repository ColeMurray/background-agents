# Modal VM backend

Open Inspect offers two Modal compute backends:

| `SANDBOX_PROVIDER` | Runtime                 | User Docker workloads |
| ------------------ | ----------------------- | --------------------- |
| `modal` (default)  | Existing gVisor sandbox | Not enabled           |
| `modal-vm`         | Modal VM                | Included              |

Selection is deployment-wide. There is no Docker checkbox or repository/session override. Mixed use
within one deployment is a follow-up. Both backends share a Modal app, account, credentials,
transport, and implementation; they have separate prepared-image pools.

## Deployment

For Terraform, set `sandbox_provider = "modal-vm"`. The existing Modal module builds and verifies
the Docker image before deploying the worker. No extra provisioning/admission flag is required. For
a standalone control plane, set `SANDBOX_PROVIDER=modal-vm` and provision the data plane first:

```bash
cd packages/modal-infra
BUILD_MODAL_VM_IMAGE=true uv run python deploy.py --build-sandbox-image
BUILD_MODAL_VM_IMAGE=true uv run modal deploy deploy.py
```

These commands create billable resources. Use the intended Modal environment and credentials. Never
deploy `src/app.py` directly. VM launches reject old or incompatible API responses rather than
falling back to standard sandboxes. Existing standard clients can still use the standard endpoints.

## Runtime and resources

The harness, bridge, workspace, IDE, and desktop run directly on the VM host. Docker is for user
workloads such as PostgreSQL, Redis, and container builds. The runtime supervises the local daemon;
user environment variables cannot enable Docker or redirect its readiness probes.

Generic `cpuCores` and `memoryMib` size the **outer VM**, not individual containers. Missing/null
values select the offering defaults (currently 2 cores and 4096 MiB). Positive explicit settings
override them. VM image builds use their scope's configured resources. Standard build sizing is
unchanged. These values are product defaults, not claimed Modal minimums.

## Snapshots and recovery

VM session snapshots are **destructive**: quiesce Docker, capture the filesystem, then confirm VM
termination. Later work restores into a new VM. Standard Modal snapshots remain non-destructive. A
failed or ambiguous capture/retirement must not be reported as a successful checkpoint.

VMs therefore keep running between turns. They are saved and stopped on inactivity, lifetime expiry,
a lost heartbeat, a runtime failure or archive; a VM that stops heartbeating is captured without its
runtime. Cancelling a session stops its VM without saving. While a save has failed or its result is
unknown, new prompts are held and the session offers to retry the save, restore the last saved
state, or discard the VM and start fresh.

Filesystem capture is not process/RAM continuity or an application-consistent database backup.
Containers must use appropriate persistence and restart policies. Live Docker pause/resume is not
provided. Raw daemon logs are truncated after clean preparation before reusable image capture.

Retried VM launches adopt only an exactly owned allocation and recover its original interactive
credentials. A predecessor must be confirmed terminated before launching a replacement. A build
whose create response is lost is marked failed; its VM runs until the provider's build sandbox
timeout (40 minutes by default, up to 70 minutes, including the 10-minute finalization grace).
Re-triggering the build uses a new build ID and allocation name, not the previous allocation.
Returned build handles are persisted for cleanup before backend validation; incompatible builds
never start and cannot publish prepared images.

Before create or restore returns, the control plane records a pending VM reference of the form
`modal-vm-session:["sessionId","sandboxId"]`. The session id selects the named allocation; the
session and sandbox (generation) ids select its ownership tags at create. The reference resolves
only while that generation's allocation runs. A not-visible reference is confirmed absent only once
its generation is older than the materialization bound: the launch window plus the endpoint
`timeout=` and a margin. Before then, a queued create could still materialize the allocation. An
older launch that materializes later may briefly block a replacement, but the single allocation name
and fenced credentials prevent overlapping work.

The authenticated `POST /api-resolve-vm-sandbox` endpoint is lookup-only. Its body contains exactly
`{"session_id":"...","sandbox_id":"..."}`; it accepts no launch settings or secrets. It finds the
running allocation by session name, checks the generation's ownership tags, and returns:

```json
{
  "success": true,
  "data": {
    "sandbox_id": "generation-id",
    "modal_object_id": "sb-real-id",
    "code_server_url": null,
    "code_server_password": null,
    "vnc_url": null,
    "vnc_password": null,
    "ttyd_url": null,
    "tunnel_urls": null,
    "sandbox_backend": "modal-vm"
  }
}
```

New VM allocations record versioned service flags and effective ports in provider-owned launch tags.
Only services enabled by these tags return URLs/passwords; extra tunnels use port-to-URL mappings.
Legacy allocations without these tags (or with unknown/incomplete metadata) resolve only the real
`modal_object_id`, not access credentials or tunnels. Resolve never infers enabled services from
environment variables, which may have contained user secrets on older allocations. Such VMs need a
new launch to recover interactive access. Resolve neither creates nor retires an allocation or
writes tunnel configuration. A stopped VM is not discoverable by name. Resolve does not return a
terminal access token; the control plane mints that token only when it still holds the generation's
sandbox auth token in memory.

Create, restore, and resolve report typed HTTP 409 error `detail` values:

- `not_visible`: resolve found no named allocation.
- `other_generation`: the ownership tags do not match.
- `window_closed`: create/restore missed the launch deadline with no owned allocation.
- `race_pending`: create/restore cannot yet see the winner after `AlreadyExistsError`, or resolve
  found a VM with none of its tunnel URLs readable yet. Like create/restore, resolve returns a
  partial tunnel map rather than waiting for ports Modal did not publish.

Create reports HTTP 501 `docker_not_available` before retiring or allocating anything when the
deployment has no verified Docker image. The control plane fails that launch as permanent instead of
resolving it. Unexpected provider errors remain 500. The pending-reference stop endpoint retains its
separate `pending_reference_not_visible` response.

## Switching backends

Changing `SANDBOX_PROVIDER` is an operator cutover, not session migration. Existing sessions and
snapshots may become unusable. Drain/retire active allocations first when feasible, retain
credentials for pending cleanup, and rebuild images under the selected backend. Do not relabel old
artifacts. Rollback to `modal` does not transparently resume VM sessions or prove old VMs have
stopped.

After changing `sandbox_provider`, apply Terraform and ensure the web app is deployed with the new
provider. The deployment step depends on `web_platform`:

- **Cloudflare**: `terraform apply` rebuilds and deploys the web Worker with the new provider. No
  separate redeploy step is needed.
- **Vercel**: after the apply, create a new production deployment through your configured CLI,
  Git-linked, or GitHub Actions deployment path. If using Actions, manually run **Deploy Web**;
  Terraform-only changes do not trigger it, and it skips deployment unless `VERCEL_API_TOKEN` and
  `VERCEL_PROJECT_ID` are configured in GitHub. See
  [Deploy the Web App](GETTING_STARTED.md#step-7-deploy-the-web-app) for the CLI and Git-linked
  paths.

Terraform updates `NEXT_PUBLIC_SANDBOX_PROVIDER`, but Vercel environment changes apply only to new
deployments and `NEXT_PUBLIC_*` values are fixed at build time. Until the new Vercel deployment is
live, `GET /api/image-builds` still filters by the old provider, so the Pre-Built Images page shows
the old provider's builds. This applies to any provider switch, not only switches to or from
`modal-vm`.

PR #2007's earlier per-session Docker/variant design was not deployed. Its schema additions and
settings are not part of this implementation, so no variant migration is required.

Provider-backed canaries must validate Docker startup, build/restore, access after adoption,
snapshot/retirement, and cleanup in the target deployment before production rollout. Unit tests
alone do not prove those provider behaviors.
