# Open-Inspect Islo Snapshot Tooling

Standalone scripts for seeding and managing optional Islo base snapshots used by Open-Inspect
sandboxes.

The control plane communicates with the Islo API directly. These scripts are for setup/deploy-time
snapshot creation, not runtime session operations. The Islo provider can also create sandboxes
directly from the maintained `ghcr.io/islo-labs/background-agents-runtime:stable` image; snapshots
are an optimization for faster boot and custom, repo-local runtime builds.

## Scripts

- **`src/bootstrap.js`** — Seeds the named Islo base snapshot from the repo-local sandbox runtime
- **`src/toolchain.js`** — Toolchain management utilities for the snapshot build sandbox

## Environment

- `ISLO_API_KEY` (required) — must have sandbox and snapshot permissions
- `ISLO_BASE_URL`
- `ISLO_BASE_SNAPSHOT` (required only when running these snapshot scripts)
- `ISLO_BASE_IMAGE` — optional parent image for snapshot builds; defaults to the generic
  `ghcr.io/islo-labs/islo-runner:latest`

## Usage

```bash
cd packages/islo-infra
npm install
ISLO_API_KEY=... ISLO_BASE_SNAPSHOT=open-inspect-runtime npm run bootstrap -- --force
```

Re-run `bootstrap` whenever `packages/sandbox-runtime` or the sandbox toolchain changes.

> **Note**: Snapshot builds are automated via Terraform only when `sandbox_provider = "islo"` and
> `islo_base_snapshot` is non-empty. The `islo-infra` Terraform module triggers a rebuild whenever
> source files change. Manual runs are only needed for initial setup or debugging.
