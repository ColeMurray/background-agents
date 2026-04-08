# Open-Inspect Daytona Snapshot Tooling

Standalone scripts for seeding and managing Daytona base snapshots used by Open-Inspect sandboxes.

The control plane communicates with the Daytona REST API directly — these scripts are for one-time
snapshot setup, not runtime operations.

## Scripts

- **`src/bootstrap.py`** — Seeds the named Daytona base snapshot from the repo-local sandbox runtime
- **`src/toolchain.py`** — Toolchain management utilities for snapshot images

## Environment

- `DAYTONA_API_KEY` (required)
- `DAYTONA_API_URL`
- `DAYTONA_TARGET`
- `DAYTONA_BASE_SNAPSHOT` (required)

## Usage

```bash
cd packages/daytona-infra
pip install daytona  # or: uv pip install daytona
python -m src.bootstrap --force
```

Re-run `bootstrap` whenever `packages/sandbox-runtime` or the sandbox toolchain changes.
