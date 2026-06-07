# Open-Inspect Islo Snapshot Tooling

Standalone scripts for seeding and managing Islo base snapshots used by Open-Inspect sandboxes.

The control plane communicates with the Islo API directly. These scripts are for setup/deploy-time
snapshot creation, not runtime session operations.

## Scripts

- **`src/bootstrap.js`** — Seeds the named Islo base snapshot from the repo-local sandbox runtime
- **`src/toolchain.js`** — Toolchain management utilities for the snapshot build sandbox

## Environment

- `ISLO_API_KEY` (required) — must have sandbox and snapshot permissions
- `ISLO_BASE_URL`
- `ISLO_BASE_SNAPSHOT` (required)
- `ISLO_BASE_IMAGE` — defaults to `ghcr.io/islo-labs/islo-runner:latest`

## Usage

```bash
cd packages/islo-infra
npm install
ISLO_API_KEY=... ISLO_BASE_SNAPSHOT=open-inspect-runtime npm run bootstrap -- --force
```

Re-run `bootstrap` whenever `packages/sandbox-runtime` or the sandbox toolchain changes.

> **Note**: Snapshot builds are automated via Terraform when `sandbox_provider = "islo"`. The
> `islo-infra` Terraform module triggers a rebuild whenever source files change. Manual runs are
> only needed for initial setup or debugging.
