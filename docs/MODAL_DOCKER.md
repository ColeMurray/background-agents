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

Filesystem capture is not process/RAM continuity or an application-consistent database backup.
Containers must use appropriate persistence and restart policies. Live Docker pause/resume is not
provided. Raw daemon logs are truncated after clean preparation before reusable image capture.

Retried VM launches adopt only an exactly owned allocation and recover its original interactive
credentials. A predecessor must be confirmed terminated before launching a replacement. Build
allocations have deterministic backend/build names and can be recovered after a lost create
response. Returned build handles are persisted for cleanup before backend validation; incompatible
builds never start and cannot publish prepared images.

## Switching backends

Changing `SANDBOX_PROVIDER` is an operator cutover, not session migration. Existing sessions and
snapshots may become unusable. Drain/retire active allocations first when feasible, retain
credentials for pending cleanup, and rebuild images under the selected backend. Do not relabel old
artifacts. Rollback to `modal` does not transparently resume VM sessions or prove old VMs have
stopped.

PR #2007's earlier per-session Docker/variant design was not deployed. Its schema additions and
settings are not part of this implementation, so no variant migration is required.

Provider-backed canaries must validate Docker startup, build/restore, access after adoption,
snapshot/retirement, and cleanup in the target deployment before production rollout. Unit tests
alone do not prove those provider behaviors.
