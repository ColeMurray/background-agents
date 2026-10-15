# Sandbox images

One build-only package owns platform dependencies for Modal, Daytona, E2B, Vercel, and OpenComputer.
Provider adapters own native creation, uploads, snapshots, restores, provider overlays, and cleanup.
The control plane does not consume build hashes or dependency inventories.

## Update dependencies

From the repository root, with Python 3.12+, uv 0.9.7, Node 24+, and npm installed:

```bash
# Edit toolchain.json, or sandbox-runtime/pyproject.toml for runtime dependencies.
# For changed runtime Python requirements, first run:
uv lock --project packages/sandbox-runtime
npm run sandbox:images -- lock
npm run sandbox:images -- lock --check
npm run sandbox:images -- plan --provider all
```

`toolchain.json` owns tool versions and archive checksums. `targets.json` owns native substrate and
runtime-user differences. `locks/` contains frozen npm closures and hash-checked Python exports.
Runtime environments are calculated directly from target configuration. Ordinary builds do not
resolve new dependency versions. To intentionally refresh distro packages, change `osRefresh`. OS
packages remain substrate-dependent; builds are not byte-for-byte attestations.

Each image owns its launch paths. Infrastructure Python is private and is not activated as the
project virtualenv. Existing images retain their legacy launch environment.

## Build

Install workspace dependencies with `npm ci` for Node adapters. Native operations require provider
credentials and create billable temporary sandboxes; they do not deploy the control plane.

| Provider     | Configuration                                                               |
| ------------ | --------------------------------------------------------------------------- |
| Modal        | Modal CLI credentials and intended environment                              |
| Daytona      | DAYTONA_API_KEY, DAYTONA_BASE_SNAPSHOT name prefix; optional API URL/target |
| E2B          | E2B_API_KEY, E2B_TEMPLATE_ID name prefix; optional API URL/CPU/memory       |
| Vercel       | VERCEL_TOKEN, VERCEL_PROJECT_ID; optional team/API URL                      |
| OpenComputer | OPENCOMPUTER_API_KEY; optional API URL/template prefix                      |

```bash
npm run sandbox:images -- build --provider e2b --output /tmp/e2b-image.json
# Output is {"reference":"<verified-native-reference>"}.
```

Verification is a build gate, not a separate CLI operation. There are no candidate record schemas,
release IDs, inventory digests, promotion commands, or release locks.

Every build verifies a fresh native restore before returning the reference. Checks include isolated
Python imports, exact pinned tool versions, plugin loading, writable user paths, SCM helpers,
OpenCode health, code-server, ttyd, Chromium screenshots, user-global pnpm execution, and the full
desktop WebSocket/RFB chain. Vercel may lack the optional ffmpeg encoder.

Manual builds use unique names. Terraform supplies deterministic names; retries re-verify retained
artifacts instead of overwriting them. Temporary verification sandboxes are terminated, including on
failure. Failed native artifacts remain for investigation and explicit cleanup.

## Deployment and refresh

Terraform uses the shared build-input hash for change detection and the existing provider bindings
for artifact selection. Modal passes the verified native image ID to function deployment; other
providers use verified template/snapshot references. E2B and Daytona now build distinct names before
switching their existing Worker bindings. The configured E2B/Daytona base names act as prefixes.
Vercel/OpenComputer retain their existing manual-reference overrides.

For manual deployment, use the returned reference in the provider's existing configuration; do not
assume building alone redirects sessions. Roll back using a previous known-good configuration and
retained artifact. Do not delete artifacts still referenced by sessions or prepared images.

### Managed base snapshot retention

Terraform base builds are immutable. Replacing their `null_resource` does not remove previous
provider artifacts. The image-build scheduler's reaper covers database-tracked prepared images; it
does not track these Terraform bases.

Use the shared cleanup command for Vercel, Daytona, and OpenComputer after deployment. Create a
local JSON policy for one provider/account and managed name prefix:

```json
{
  "provider": "opencomputer",
  "protectedReferences": ["openinspect-runtime-0123456789abcdef"],
  "keepLatest": 5,
  "minAgeMs": 604800000
}
```

`keepLatest` and `minAgeMs` are optional; omitting them selects the command's retention defaults.
Always populate `protectedReferences` from the actual deployed configuration, including **every**
worker/environment sharing the provider account/project, manual pins, and rollback targets. Include
any bases needed by saved sessions or prepared images. Entries match exact provider IDs or exact
base-build names; protecting a Vercel name retains every snapshot under that name. The command
requires at least one protected reference and, when managed artifacts exist, a matching managed
artifact. Every protected reference matching the managed naming pattern must resolve in inventory,
even when another protection matches; missing managed references abort both preview and apply.
Manual and out-of-scope references remain allowed. A prefix is ownership scope, not evidence that an
artifact is unused.

| Provider     | Environment variables                                                                         | Policy prefix                                          |
| ------------ | --------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Vercel       | `VERCEL_TOKEN`, `VERCEL_PROJECT_ID`; optional `VERCEL_TEAM_ID`, `VERCEL_SANDBOX_API_BASE_URL` | Defaults to `openinspect-base`                         |
| Daytona      | `DAYTONA_API_KEY`, `DAYTONA_API_URL`                                                          | Required: the Terraform `daytona_base_snapshot` prefix |
| OpenComputer | `OPENCOMPUTER_API_KEY`; optional `OPENCOMPUTER_API_URL`                                       | Defaults to `openinspect-runtime`                      |

Only complete Terraform base names match: `<prefix>-<16 hex hash>`, or
`<prefix>-m<memory GiB>-<16 hex hash>` for Daytona. Session checkpoints, prepared images, manual
timestamped builds, and verification sandboxes are excluded. The newest ready provider snapshots are
retained in addition to explicit protections. Recent creation or use, unknown timestamps, and
nonterminal states also prevent deletion. Failed terminal builds can age out without consuming the
ready-snapshot retention count. Provider readiness alone does not attest that smoke verification
succeeded; keep known-good rollback artifacts explicitly protected.

```bash
# Preview: lists keep/delete decisions as JSON, makes no mutations.
npm run --silent sandbox:cleanup-base-snapshots -- --policy /tmp/base-retention.json

# Refresh protections, inspect the preview, then delete eligible artifacts.
npm run --silent sandbox:cleanup-base-snapshots -- --policy /tmp/base-retention.json --apply
```

The npm command builds the shared package and bundles the Node entry point before running it.
Inventory and deletion use the canonical Vercel/Daytona clients and OpenComputer's `Snapshots` SDK;
the typed adapters only identify base artifacts and normalize their metadata for the retention
planner. Provider request handling and pagination stay with those clients. Diagnostics go to stderr
so stdout remains the JSON cleanup report.

Pause deployments and manual reference changes while collecting protections and running cleanup. Run
the same command periodically in your operator job only if it refreshes protections and shares the
deployment lock. This command does not discover deployed workers or add an automatic schedule; a
static policy cannot prove a snapshot remains unreferenced during a deployment. It deliberately runs
separately from Terraform's build/destroy steps, which execute before workers switch bases.

Listing completes before deletion begins, including every provider page. Malformed responses or
unmatched protection abort cleanup. A delete error stops the batch and exits nonzero; earlier
deletions remain applied and a subsequent run can retry safely. Daytona deletion is asynchronous.
Vercel discovery uses retained named sandbox records; snapshots whose source sandbox record has
already been removed need provider-native inventory/manual review. Modal retention is outside this
command's scope; E2B templates also use a separate provider lifecycle.

The `filesystem` phase also runs `opencode models --refresh` for the runtime user, so sessions
without a prepared image still see models newer than the pinned OpenCode release. It is best-effort:
a failure leaves OpenCode's built-in catalog in use. Prepared repository and environment images
refresh the catalog on every build.

**Prepared repository images do not automatically refresh when the base toolchain changes.** Use the
existing repository/environment image-build workflow to rebuild them after dependency-only updates
when needed. Runtime version reporting, compatibility floors, and saved-session behavior are
unchanged. This package adds no database columns or callback fields.

## Build implementation and local validation

One conservative source hash covers installation and build/deployment tooling. Changes to broad
provider or Vercel control-plane/shared source roots may trigger extra builds; there is no separate
installed-image hash or exact-content attestation.

`pack` creates a fresh staging directory from explicitly allowed payload roots. It preserves file
modes and contained symlinks, rejects missing inputs, and never reuses another caller's directory.
No detailed file manifest or shared staging-cache reconciliation remains. Build from a stable
checkout. Staging directories under `.cache/sandbox-images` may be removed when no build is using
them.

```bash
uv run --frozen --project packages/sandbox-images --extra dev pytest packages/sandbox-images/tests
bundle=$(python3 packages/sandbox-images/cli.py pack --provider e2b)
docker build --platform linux/amd64 -f packages/sandbox-images/Dockerfile -t openinspect-image-contract "$bundle"
docker run --rm --platform linux/amd64 openinspect-image-contract
```

For Amazon Linux, use a Vercel bundle and `--build-arg BASE_IMAGE=amazonlinux:2023`. Native-amd64 CI
tests both OS families. Chromium may trap under amd64 emulation on ARM Macs. Reference-container
success does not replace provider-native verification.

See [design scope](../../docs/plans/sandbox-image-dependency-consolidation.md).
