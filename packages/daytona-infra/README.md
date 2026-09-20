# OpenInspect Daytona OCI Image Tooling

Standalone publisher and native verifier for the Daytona runtime OCI image.

The control plane communicates with Daytona directly; these scripts publish the runtime artifact
selected by deployment rather than participating in session runtime operations.

## Scripts

- **`src/bootstrap.py`** — Publishes an immutable OCI candidate and verifies it at 2 and 4 GiB
- **`src/toolchain.py`** — Thin transport for the [shared image bundle](../sandbox-images/README.md)

## Environment

- `DAYTONA_API_KEY` (required) — must create, inspect, and delete sandboxes
- `DAYTONA_API_URL`
- `DAYTONA_TARGET`
- `DAYTONA_IMAGE_REPOSITORY` (required) — registry-qualified repository such as
  `ghcr.io/example/open-inspect-daytona`; Docker authentication must already be configured

## Usage

```bash
cd packages/daytona-infra
uv run --frozen python -m src.bootstrap
```

Re-run `bootstrap` whenever `packages/sandbox-runtime` or the sandbox toolchain changes. The script
pushes a unique candidate and verifies the exact manifest digest with temporary native sandboxes.
Temporary sandboxes are deleted in `finally` and also carry a short TTL. The command emits
`{"reference":"repository@sha256:..."}` only after both allocations pass.

Terraform never builds or publishes this artifact. The trusted main apply job publishes to GHCR;
operators using another registry run the same command with Docker's credential store configured.
Private images require a read-only registry integration in the Daytona organization. Keep packages
private unless the operator explicitly chooses otherwise, and retain digests referenced by current
deployments or prebuilds.
