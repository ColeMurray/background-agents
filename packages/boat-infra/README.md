# OpenInspect Boat Snapshot Tooling

Builds and prunes the Boat **named base snapshots** used to create Open-Inspect Boat sandboxes.

The control plane talks to the Boat REST API directly at runtime. These files build and prune base
snapshots and provide the launcher baked into them.

## What's here

- **[Shared image package](../sandbox-images/README.md)** — owns the substrate, dependency pins,
  frozen installation bundle, runtime wheel, and verification.
- **`build-template.py`** — stages the shared bundle, installs it in a throwaway Boat sandbox
  through the REST API (standard library only, no SDK; HTTPS only, redirects refused, one
  idempotency key per create), saves the sandbox's disk as a named snapshot, and verifies a fresh
  deploy from that name. Its sandboxes are created private, so one billed to an organization is
  never shared. Used both for manual builds and by the Terraform module. Its `prune` command removes
  superseded Terraform-built bases after deployment.
- **`launcher.sh`** — baked at `/home/user/openinspect/launcher.sh`. A create-time setup script that
  Boat starts the moment a new sandbox's machine is up waits for the control plane's launch marker
  (written once the sandbox is known private and its tunnel env file is in the workspace) and execs
  it; the control plane starts it again, detached, on every resume. It links `/workspace` and `/app`
  into the home directory (the part of the disk a Boat snapshot saves), waits for the restored
  toolchain, holds a single-instance lock in `/tmp`, which the remount that ends Boat's lazy restore
  never touches (exit 75 means a runtime is already running, as when a resume gets the parked
  machine back), picks the boot mode from the completed-boot marker the runtime writes
  (`OI_BOOT_COMPLETE_MARKER`), and execs `python -m sandbox_runtime.entrypoint` with its output in
  `/home/user/.openinspect/supervisor.log`.

The snapshot runs nothing of its own. On every sandbox create the control plane passes the
per-sandbox env — `CONTROL_PLANE_URL`, `SESSION_CONFIG`, auth token, user secrets — as create-time
`env`, asks for a private sandbox with its ports routed, and passes a setup script that waits for
the launch marker the control plane writes once the sandbox is known private and its tunnel env file
is in the workspace, then execs the launcher. On every resume it starts the launcher again,
detached: on a new machine the launcher boots the runtime in restored mode, and on the parked
machine of a quick resume it finds the runtime still running and exits 75.

Prebuilt images are named snapshots too, saved by the control plane as `oi-img-<scope>-<digest>`
from a build sandbox that deployed from this base snapshot. A build sandbox is created with the boot
markers alone; its env arrives as `/tmp/openinspect-image-build.env` once the sandbox is private,
and the launcher (`IMAGE_BUILD_MODE=true`) sources that file once, removes it, and keeps the build's
lock, log and runtime state under `/tmp` too, so the saved disk carries the workspace and nothing of
the build. Those names are the control plane's to create and delete; the base snapshot and the
images share the wallet's named-snapshot allowance. Deleting a source base does not affect existing
sandboxes or standalone repository and environment images.

## Auth: one credential

- **`BOAT_API_KEY`** — the runtime key the control-plane worker uses for the Boat REST API (and the
  code-server/VNC password HMAC), **and** what this build uses. Create it in the Boat dashboard
  under API keys.

## Manual build

Use the repository-root [build command](../sandbox-images/README.md). Native builds create unique
`<prefix>-<12 hex>-<timestamp>` names and never overwrite the selected snapshot. Select the verified
name before directing traffic to it.

```bash
cd packages/boat-infra
uv sync --frozen
export BOAT_API_KEY=boat_…             # Boat dashboard → API keys
export BOAT_BASE_SNAPSHOT=open-inspect # name prefix; the build appends a hash and timestamp
uv run --frozen python build-template.py
```

Optional: `BOAT_API_URL` (default `https://boat.dev/api/v1`), `BOAT_ORG` (organization wallet),
`BOAT_BUILD_SANDBOX_TYPE` (default `default`; the saved disk is the same whatever the size).

Rebuild whenever `packages/sandbox-runtime`, `packages/sandbox-images` or this directory changes.

> Builds are automated via Terraform when `sandbox_provider = "boat"`. The production
> `terraform/environments/production/boat.tf` hashes the shared build inputs through the
> `sandbox-images` CLI, then passes the hash to `terraform/modules/boat-infra` to build a new
> snapshot under a new name when those inputs change. The control-plane Worker switches only after
> verification; Terraform then prunes superseded bases. Manual builds are only for initial setup or
> debugging.
>
> Boat snapshots save `/home`, new top-level directories and changes under `/etc`, `/usr`, `/opt`,
> `/var`, `/root` and `/srv`, but not `/tmp` or `~/.cache`. The image therefore keeps `/app` and
> `/workspace` under `/home/user` behind symlinks the launcher recreates on every boot.

## Prune base snapshots

Terraform runs pruning after the control-plane Worker switches to the selected snapshot, once per
change to the selected name, including the first apply after the pruning resource is introduced.
Only names matching exactly `<prefix>-<16 lowercase hex>` are candidates. It retains the deployed
base and the newest other `ready` candidate as a rollback base, skips `saving` snapshots, and
deletes all remaining `ready` or `failed` candidates. Manual `<prefix>-<12 hex>-<timestamp>` names,
`oi-img-*` images, other names and snapshots under other or longer prefixes are untouched.

Use a unique prefix for each deployment sharing a Boat account or organization wallet. Reusing a
prefix makes another deployment's live base eligible for deletion.

To preview the same selection manually:

```bash
cd packages/boat-infra
uv sync --frozen
export BOAT_API_KEY=boat_...
export BOAT_BASE_SNAPSHOT=open-inspect
export BOAT_DEPLOYED_SNAPSHOT="open-inspect-<16 lowercase hex>"
uv run --frozen python build-template.py prune --dry-run
```

`BOAT_BASE_SNAPSHOT` is the prefix, not a full name. Set `BOAT_DEPLOYED_SNAPSHOT` to the exact full
name the Worker currently uses, not an unselected build candidate. It must be a `ready`
Terraform-built base under that prefix. Optional `BOAT_API_URL` and `BOAT_ORG` must address the same
Boat account or organization wallet as that deployment. A missing, non-`ready` or nonmatching
deployed snapshot fails pruning before any deletion.

The command prints names it keeps and why, names it would delete (or deleted), and the wallet's
snapshot allowance before and after. `--dry-run` previews the selection and deletes nothing; its
after allowance is unchanged by the command. Only after confirming the selection, rerun
`uv run --frozen python build-template.py prune` without `--dry-run` to delete the selected names.

Only one rollback base is retained. A Worker rollback across two or more base generations may
reference a deleted base; sessions without prebuilt images then fail to create until a deployment
rebuilds that name. Existing sandboxes and prebuilt repository and environment images are unaffected
by deleting their source base.

## Verification

Unit tests for the builder live in `packages/sandbox-images/tests`; the bridge ↔ control-plane
WebSocket path can only be exercised against a running control plane.

Prerequisites: a control plane configured with `SANDBOX_PROVIDER=boat`, `BOAT_API_KEY` and
`BOAT_BASE_SNAPSHOT` (plus GitHub App credentials for repository sessions), a public control-plane
URL the sandbox bridge can reach, and the snapshot built.

| Criterion                     | Test method                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------ |
| Fresh session works           | Bridge connects; agent responds to a prompt                                    |
| Stop → resume works           | Agent responds to a new prompt after resume; files from before the stop remain |
| Idle stops (archives)         | Idle timeout triggers `POST /sandboxes/{id}/stop`; the session is resumable    |
| TTL lapse recovers            | Past the TTL the sandbox is archived; the next prompt resumes it               |
| code-server survives resume   | Same URL and password work after resume                                        |
| Expired snapshot spawns fresh | A sandbox stopped for over 14 days is replaced by a fresh one                  |
| Reserved ports are refused    | A tunnel or service on 6080 or 8090 fails the spawn with a clear error         |
