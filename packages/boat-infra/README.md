# OpenInspect Boat Snapshot Tooling

Builds and prunes the Boat **saved base snapshots** used to create Open-Inspect Boat sandboxes.

The control plane talks to the Boat REST API directly at runtime. These files build and prune base
snapshots and provide the launcher baked into them.

## What's here

- **[Shared image package](../sandbox-images/README.md)** — owns the substrate, dependency pins,
  frozen installation bundle, runtime wheel, and verification.
- **`build-template.py`** — stages the shared bundle, installs it in a throwaway Boat sandbox
  through the REST API (standard library only, no SDK; HTTPS only, redirects refused, one
  idempotency key per create), saves the sandbox's disk as a saved snapshot, and verifies a fresh
  deploy from that name. Its sandboxes are created private, so one billed to an organization is
  never shared. Used both for manual builds and by the Terraform module. Its `prune` command removes
  superseded Terraform-built bases after deployment using an explicit deployed/replaced pair.
- **`prune-deployed-snapshots.py`**: runs after the Worker deployment in Terraform, reads
  Cloudflare's confirmed deployments and version bindings through the builder's same HTTPS-only,
  nonredirecting opener, and verifies the active deployment before invoking the Boat pruner.
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

Prebuilt images are saved snapshots too, saved by the control plane as `oi-img-<scope>-<digest>`
from a build sandbox that deployed from this base snapshot. A build sandbox is created with the boot
markers alone; its env arrives as `/tmp/openinspect-image-build.env` once the sandbox is private,
and the launcher (`IMAGE_BUILD_MODE=true`) sources that file once, removes it, and keeps the build's
lock, log and runtime state under `/tmp` too, so the saved disk carries the workspace and nothing of
the build. Those names are the control plane's to create and delete; the base snapshot and the
images share the wallet's saved-snapshot allowance. Deleting a source base does not affect existing
sandboxes or standalone repository and environment images.

## Authentication

- **`BOAT_API_KEY`** — the runtime key the control-plane worker uses for the Boat REST API (and the
  code-server/VNC password HMAC), **and** what this build uses. Create it in the Boat dashboard
  under API keys.
- **Cloudflare deployment token**: the deployment-history wrapper needs Workers Scripts: Read
  access; the existing Workers Scripts: Edit deployment token is sufficient. Terraform supplies the
  token, Cloudflare account, Worker name and deployment ID automatically; no extra manual setup is
  needed. Direct manual builder commands only need the Boat credential.

## Manual build

Use the repository-root [build command](../sandbox-images/README.md). Native builds create unique
`<prefix>-<12 hex>-<timestamp>` names and never overwrite the selected snapshot. Select the verified
name before directing traffic to it.

Base prefixes must be 1-46 lowercase letters, digits or dashes. `oi-img` and every prefix starting
with `oi-img-` are reserved for prebuilt images and rejected by Terraform, its Boat module, and
build/prune validation, including manual builds and prune candidates.

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

Terraform runs `prune-deployed-snapshots.py` after the control-plane Worker switches to the selected
snapshot, including the first apply after the pruning resource is introduced. Cleanup is triggered
by changes to the snapshot name, Boat API URL or organization, even with the same build hash, not by
credential changes alone.

The wrapper verifies the expected active deployment and desired Boat snapshot against Cloudflare's
confirmed deployment list and version bindings. It follows actual deployed base transitions,
skipping same-base redeploys: `A -> B -> A -> C` retains `C` and `A`. Snapshot `createdAt` values
and newer undeployed snapshots never establish rollback provenance. Missing or inconsistent history
or split deployments fail without deleting anything. No distinct predecessor in available history (a
new deployment or truncated history) is a successful skip with no deletions, not a guess.

A provider, Boat API URL, organization or prefix change ends the history search: the old scope is
untouched and the wrapper passes an explicit empty `BOAT_REPLACED_SNAPSHOT`, with no rollback base
in the new scope. When pruning proceeds, it retains at most two applicable bases, not necessarily
two on a first deployment or scope change. Only exact `<prefix>-<16 lowercase hex>` names are
candidates. It skips `saving` snapshots and deletes remaining `ready` or `failed` candidates. Manual
`<prefix>-<12 hex>-<timestamp>` names, prebuilt images, other names and snapshots under other or
longer prefixes are untouched.

Use a unique prefix for each deployment sharing a Boat account or organization wallet. Reusing a
prefix makes another deployment's live base eligible for deletion.

Serialize deployments, direct Worker rollbacks and pruning. The wrapper rechecks the active
deployment after reading history and before invoking Boat pruning, aborting without deletion if it
changed, but cannot atomically lock Cloudflare and Boat.

To preview an explicit pair manually:

```bash
cd packages/boat-infra
uv sync --frozen
export BOAT_API_KEY=boat_...
export BOAT_BASE_SNAPSHOT=open-inspect
export BOAT_DEPLOYED_SNAPSHOT="open-inspect-<current-16-lowercase-hex>"
export BOAT_REPLACED_SNAPSHOT="open-inspect-<previous-16-lowercase-hex>"
uv run --frozen python build-template.py prune --dry-run
```

`BOAT_BASE_SNAPSHOT` is the prefix, not a full name. Both `BOAT_DEPLOYED_SNAPSHOT` and
`BOAT_REPLACED_SNAPSHOT` must be explicitly set. Replace the placeholders with the exact current
name and the distinct base it actually replaced, taken from the Worker's confirmed deployment
history, not snapshot timestamps or an unselected build candidate. The deployed value and any
nonempty replaced value must be `ready` Terraform-built names under the same prefix, with exactly 16
lowercase hex characters after the prefix. Set `BOAT_REPLACED_SNAPSHOT=""` only when you know there
was no previous base in the current prefix and wallet, such as a confirmed scope boundary; missing
or truncated history is not proof. Optional `BOAT_API_URL` and `BOAT_ORG` must address that same
Boat wallet. A missing, non-`ready` or nonmatching saved base fails pruning before any deletion. The
direct command validates the pair against Boat; unlike the wrapper, it does not read or recheck
Worker deployment history.

The command prints names it keeps and why, names it would delete (or deleted), and the wallet's
snapshot allowance before and after. `--dry-run` previews the selection and deletes nothing; its
after allowance is unchanged by the command. A dry run against the deployment's live wallet is
required; only after confirming the selection, rerun
`uv run --frozen python build-template.py prune` without `--dry-run` to delete the selected names.

At most one rollback base is retained. A Worker rollback across two or more base generations may
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
