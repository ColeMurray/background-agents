# Sandbox images

One build-only package owns platform dependencies for Modal, Daytona, E2B, Vercel, and OpenComputer.
Provider adapters own native creation, uploads, snapshots, restores, provider overlays, and cleanup.
The control plane does not consume build hashes or dependency inventories.

## Update dependencies

From the repository root, with Python 3.12+, uv 0.9.7, Node 22+, and npm installed:

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

| Provider     | Configuration                                                                         |
| ------------ | ------------------------------------------------------------------------------------- |
| Modal        | Modal CLI credentials and intended environment                                        |
| Daytona      | DAYTONA_API_KEY, registry-qualified DAYTONA_IMAGE_REPOSITORY; optional API URL/target |
| E2B          | E2B_API_KEY, E2B_TEMPLATE_ID name prefix; optional API URL/CPU/memory                 |
| Vercel       | VERCEL_TOKEN, VERCEL_PROJECT_ID; optional team/API URL                                |
| OpenComputer | OPENCOMPUTER_API_KEY; optional API URL/template prefix                                |

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

Manual builds use unique names. For snapshot/template builders, Terraform supplies deterministic
names and retries re-verify retained artifacts instead of overwriting them. Daytona publishes a
unique OCI candidate and verifies its exact digest at both 2 and 4 GiB. Temporary verification
sandboxes are terminated, including on failure. Failed artifacts remain for explicit cleanup.

## Deployment and refresh

Terraform uses the shared build-input hash for change detection and the existing provider bindings
for artifact selection. Modal passes the verified native image ID to function deployment; other
providers use verified template/snapshot references. E2B builds distinct names before switching its
Worker binding; the configured E2B base name acts as a prefix. Vercel/OpenComputer retain their
existing manual-reference overrides.

Daytona is the exception: the trusted main deployment workflow publishes to
`DAYTONA_IMAGE_REPOSITORY` on GHCR, natively verifies the digest, then supplies it as Terraform's
`daytona_base_image` input and the Worker's `DAYTONA_BASE_IMAGE` binding. Terraform never builds it.
Configure a Daytona organization registry integration with a read-only pull credential for private
images (GHCR requires package read access). Publication does not make the package public. PR builds
never publish; PR plans use `DAYTONA_BASE_IMAGE` or the currently deployed Terraform output. The
first plan requires an explicitly configured, verified digest. For another registry, authenticate
Docker and run the same build command manually.

For manual deployment, use the returned reference in the provider's existing configuration; do not
assume building alone redirects sessions. Roll back using a previous known-good configuration and
retained artifact. Do not delete artifacts still referenced by sessions or prepared images.

Daytona prebuild compatibility includes the OCI digest and normalized CPU/RAM. New sessions miss old
prebuilds immediately after a digest/settings change; the existing image-build scheduler rebuilds
them. Other providers retain their existing refresh behavior: use the repository/environment
image-build workflow after dependency-only updates when needed. Runtime version reporting,
compatibility floors, and saved-session behavior are unchanged.

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
