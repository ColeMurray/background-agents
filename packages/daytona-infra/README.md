# OpenInspect Daytona Snapshot Tooling

Standalone scripts for seeding and managing Daytona base snapshots used by Open-Inspect sandboxes.

The control plane communicates with the Daytona REST API directly — these scripts are for one-time
snapshot setup, not runtime operations.

## Scripts

- **`src/bootstrap.py`** — Seeds the named Daytona base snapshot from the repo-local sandbox runtime
- **`src/toolchain.py`** — Thin transport for the [shared image bundle](../sandbox-images/README.md)

## Environment

- `DAYTONA_API_KEY` (required) — must have **Snapshots: Read, Write, Delete** permissions
- `DAYTONA_API_URL`
- `DAYTONA_TARGET`
- `DAYTONA_BASE_SNAPSHOT` (required)

## Usage

```bash
cd packages/daytona-infra
uv run --frozen python -m src.bootstrap
```

Re-run `bootstrap` whenever `packages/sandbox-runtime` or the sandbox toolchain changes. The script
creates a uniquely named candidate and verifies a fresh restore. It never deletes the selected
snapshot. The command returns a verified reference; deployment selects it through the existing
provider settings. See the [shared build workflow](../sandbox-images/README.md).

> **Note**: Snapshot builds are automated via Terraform when `sandbox_provider = "daytona"`. The
> `daytona-infra` Terraform module triggers a rebuild whenever source files change. Manual runs are
> only needed for initial setup or debugging.
