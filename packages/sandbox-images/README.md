# Sandbox images

One build-only package owns platform dependencies for Modal, Daytona, E2B, Vercel, and OpenComputer.
Provider adapters own native creation, environment overlays, snapshots, verification restores, and
cleanup. Repository setup hooks and session lifecycle remain in their existing packages.

## Updating dependencies

From the repository root, with Python 3.12+, uv 0.9.7, Node 22+, and npm installed:

```bash
# Change toolchain.json for platform tools, or sandbox-runtime/pyproject.toml for runtime Python dependencies.
# When changing Python requirements, first run: uv lock --project packages/sandbox-runtime
npm run sandbox:images -- lock
npm run sandbox:images -- lock --check
npm run sandbox:images -- plan --provider all
```

`toolchain.json` owns exact tool versions and downloaded archive checksums. `targets.json` owns
native substrate and runtime-user differences. `locks/` contains frozen npm closures and
hash-checked Python exports. `runtime-environments.json` is generated, Worker-safe launch
configuration. Do not edit generated files directly. Ordinary builds never resolve new versions. To
intentionally refresh distro packages without changing language dependencies, change `osRefresh` in
the toolchain manifest.

The runtime wheel is built from staged source in an isolated, frozen build-tool venv, then installed
without dependency resolution into its separate runtime venv. OS package versions remain
substrate-dependent and are recorded in the inventory. Vercel's Amazon Linux target records video
encoding as unavailable when its repositories lack ffmpeg; agent, browser, desktop, editor,
terminal, and SCM tools are mandatory. Platform installs are image-build-only, never session startup
work.

## Build, verify, promote

Install workspace packages with `npm ci` for the Node-based adapters. Provide the same provider
credentials used by the existing infrastructure scripts:

| Provider     | Required configuration                                                                 |
| ------------ | -------------------------------------------------------------------------------------- |
| Modal        | Modal CLI credentials and the intended Modal environment                               |
| Daytona      | `DAYTONA_API_KEY`, `DAYTONA_BASE_SNAPSHOT` (candidate prefix); optional API URL/target |
| E2B          | `E2B_API_KEY`, `E2B_TEMPLATE_ID` (candidate prefix); optional API URL/CPU/memory       |
| Vercel       | `VERCEL_TOKEN`, `VERCEL_PROJECT_ID`; optional team/API URL                             |
| OpenComputer | `OPENCOMPUTER_API_KEY`; optional API URL/template prefix                               |

Native operations create billable temporary sandboxes. They do not deploy the control plane or
replace the selected image. Failed verification exits nonzero without publishing a candidate record.
Temporary verification sandboxes are terminated; candidates remain available for investigation and
explicit cleanup.

```bash
npm run sandbox:images -- build --provider e2b --output /tmp/e2b-candidate.json
npm run sandbox:images -- verify --provider e2b --candidate /tmp/e2b-candidate.json
npm run sandbox:images -- promote --candidate /tmp/e2b-candidate.json \
  --store terraform/environments/production/sandbox-images.lock.json
```

Review and **commit** the release lock before deploying. It retains immutable release records, the
selected release, and the previous selection. Keep a separate lock per deployment/account. Candidate
JSON contains no credentials but includes native references and dependency inventory; treat it as
operational metadata. CI candidate artifacts expire and are only a transport into the durable Git
lock.

Terraform projects selected records into compact `SANDBOX_BASE_RELEASES` configuration; Node hosts
can set the same JSON map. Each entry contains `schemaVersion`, `baseReleaseId`, `artifact`
(provider/scope/reference), and `identity` (recipeDigest/inventoryDigest/target/runtimeVersion).
Full inventories and verification evidence stay in the release lock, not Worker bindings. Terraform
rejects configuration larger than 5,000 UTF-8 bytes. Modal additionally deploys its function
environment with the selected native image ID. Recipe changes alone never advance a compatibility
floor.

### Staged first rollout

1. Apply migration 0075 before deploying the new control plane.
2. Deploy the compatible launch/readers, retaining existing provider settings. E2B's
   worker-before-template dependency is preserved.
3. Build and verify a candidate for each enabled provider, review and commit its selection, then
   deploy. Daytona/E2B candidate creation no longer overwrites their old configured
   snapshot/template names. A first installation must select the new candidate before it can serve
   sessions.
4. Allow prepared repository images to rebuild. Registration captures the selected base release;
   callbacks must match its recipe, inventory, and target.
5. Test fresh sessions, repository-image creation, restore/pause, and services in the deployment's
   real account before retiring old artifacts.

With an empty selection lock, existing provider configuration remains the legacy fallback. Existing
managed Modal/Vercel/OpenComputer Terraform builds still use their verified managed artifacts;
adding a release-lock selection makes promotion explicit and enables release-aware repository-image
refresh. Saved session snapshots are not invalidated merely because a base release changes.

### Rollback

```bash
npm run sandbox:images -- rollback --provider e2b \
  --store terraform/environments/production/sandbox-images.lock.json
```

Review/commit and redeploy. Rollback changes selection, not image contents. Retain old native
artifacts while they are selected, previous, or referenced by saved sessions/prepared images. There
is intentionally no automatic artifact deletion. Re-verify an old candidate before rollback if its
provider may have expired it.

## Verification and local development

`plan` separates installed `inputs`/`recipeDigest` from orchestration `buildInputs`/`buildDigest`.
`pack` stages only installation inputs: runtime skills/assets, installers, verification, and locks.
Provider adapters and build tooling stay outside the image. `hash` returns the build trigger as
`hash` and installed identity as `recipe`; Terraform uses recipe-based candidate names so changes to
orchestration can re-verify existing artifacts. The root npm lock is conservatively tracked in Node
builders' build inputs, never their installed recipe. Modal's explicit `CACHE_BUSTER` remains an
installed recipe input. Missing inputs and escaping symlinks fail closed, and existing bundles are
never overwritten while a native build may still be reading them.

The baked `/app/openinspect-image.json` separates recipe digest, measured inventory, and runtime
compatibility generation. A release ID additionally includes the native reference and provider
scope. Runtime ready events and image-build callbacks read installed files; a launch-time version
label cannot attest to an image. Legacy launch shims read the legacy image's adjacent runtime
manifest.

Every candidate must pass service verification after a fresh native restore: isolated Python
imports, pinned tool execution, plugin loading, writable user paths, SCM wrapper/helper, OpenCode
health, code-server, ttyd, Chromium screenshots, and the Xvfb/Fluxbox/VNC/noVNC chain. Optional
missing capabilities are recorded.

```bash
uv run --frozen --project packages/sandbox-images --extra dev pytest packages/sandbox-images/tests
bundle=$(python3 packages/sandbox-images/cli.py pack --provider e2b)
docker build --platform linux/amd64 -f packages/sandbox-images/Dockerfile -t openinspect-image-contract "$bundle"
docker run --rm --platform linux/amd64 openinspect-image-contract
```

The reference image supports an Amazon Linux substrate via `--build-arg BASE_IMAGE=amazonlinux:2023`
with a Vercel bundle. Native-amd64 CI checks both OS families; Chromium can trap under QEMU amd64
emulation on ARM Macs. Reference-container success does not replace provider-native verification.
