# OpenInspect Boat Snapshot Tooling

Builds the Boat **named snapshot** that Open-Inspect Boat sandboxes are deployed from.

The control plane talks to the Boat REST API directly at runtime — these files are only for building
the base snapshot, plus the launcher it bakes in.

## What's here

- **[Shared image package](../sandbox-images/README.md)** — owns the substrate, dependency pins,
  frozen installation bundle, runtime wheel, and verification.
- **`build-template.py`** — stages the shared bundle, installs it in a throwaway Boat sandbox
  through the REST API (standard library only, no SDK; HTTPS only, redirects refused, one
  idempotency key per create), saves the sandbox's disk as a named snapshot, and verifies a fresh
  deploy from that name. Sandboxes billed to an organization are made private as soon as they are
  created. Used both for manual builds and by the Terraform module.
- **`launcher.sh`** — baked at `/home/user/openinspect/launcher.sh`. The control plane starts it,
  detached, on every boot: it links `/workspace` and `/app` into the home directory (the part of the
  disk a Boat snapshot saves), waits for the restored toolchain, holds a single-instance lock (exit
  75 means a runtime is already running), picks the boot mode from the completed-boot marker the
  runtime writes (`OI_BOOT_COMPLETE_MARKER`), and execs `python -m sandbox_runtime.entrypoint` with
  its output in `/home/user/.openinspect/supervisor.log`.

The snapshot runs nothing of its own. On every sandbox create the control plane passes the
per-sandbox env — `CONTROL_PLANE_URL`, `SESSION_CONFIG`, auth token, user secrets — as create-time
`env` and starts the launcher; on every resume it starts the launcher again, which boots the runtime
in restored mode.

## Auth: one credential

- **`BOAT_API_KEY`** — the runtime key the control-plane worker uses for the Boat REST API (and the
  code-server/VNC password HMAC), **and** what this build uses. Create it in the Boat dashboard
  under API keys.

## Manual build

Use the repository-root [build command](../sandbox-images/README.md). Native builds create unique
names and never overwrite the selected snapshot. Select the verified name before directing traffic
to it.

```bash
cd packages/boat-infra
uv sync --frozen
export BOAT_API_KEY=boat_…             # Boat dashboard → API keys
export BOAT_BASE_SNAPSHOT=open-inspect # name prefix; the build appends the input hash
uv run python build-template.py
```

Optional: `BOAT_API_URL` (default `https://boat.dev/api/v1`), `BOAT_ORG` (organization wallet),
`BOAT_BUILD_SANDBOX_TYPE` (default `default`; the saved disk is the same whatever the size).

Rebuild whenever `packages/sandbox-runtime`, `packages/sandbox-images` or this directory changes.

> Builds are automated via Terraform when `sandbox_provider = "boat"`. The
> `terraform/modules/boat-infra` module hashes the shared build inputs and builds a new snapshot
> (under a new name) on `terraform apply` when any of them change. Manual runs are only for initial
> setup or debugging.
>
> Boat snapshots save `/home`, new top-level directories and changes under `/etc`, `/usr`, `/opt`,
> `/var`, `/root` and `/srv`, but not `/tmp` or `~/.cache`. The image therefore keeps `/app` and
> `/workspace` under `/home/user` behind symlinks the launcher recreates on every boot.

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
