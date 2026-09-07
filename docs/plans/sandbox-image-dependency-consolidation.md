# Sandbox image dependency consolidation

## Decision and scope

Consolidate installation knowledge, not image release management. This revision supersedes the
earlier proposal for recipe/inventory identities, a release registry, promotion/rollback commands,
and release-aware prepared-image refresh.

The problem is duplicated tool versions, dependency resolution, installation scripts, and service
checks across Modal, Daytona, E2B, Vercel, and OpenComputer. Updating one dependency should involve
one manifest/lock change and a consistent build/verification workflow.

## Architecture

| Owner                                        | Responsibility                                                                                                   |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `packages/sandbox-images`                    | Tool pins, lockfiles, OS-specific installation phases, staged payload, build-input hashing, shared verification  |
| Provider infrastructure packages             | Native image creation, upload, snapshot/restore, provider-specific overlays, retry and temporary sandbox cleanup |
| Terraform and existing provider settings     | Build triggers and the artifact reference used for new sandboxes                                                 |
| `packages/sandbox-runtime`                   | Installed runtime, artifact-owned launch paths, existing runtime compatibility version                           |
| Existing control-plane image-build subsystem | Repository setup hooks, prepared images, callbacks, compatibility and rebuild policy, unchanged                  |

Build flow:

1. Validate frozen dependency inputs.
2. Stage only installation files into an isolated build context.
3. Let the provider adapter construct its native image using the shared installer.
4. Restore the resulting artifact into a temporary sandbox and run common verification.
5. Return the native artifact reference only after verification succeeds.
6. Deploy that reference through existing provider configuration.

No application component needs to understand dependency inventories or build hashes.

## Shared installation package

- `toolchain.json` owns exact tool versions and checksums for explicit binary downloads.
- `targets.json` owns substrate, OS family, runtime user/home, and Node version selection.
- `locks/` owns frozen npm dependency closures and hash-checked Python exports.
- Runtime Python requirements remain in `sandbox-runtime/pyproject.toml` and its lockfile.
- `install/` owns common language, tool, runtime, and filesystem setup, with Debian and Amazon Linux
  OS package lists kept separate.
- Provider SDKs and build-only tooling are not installed into the sandbox.

The private infrastructure Python environment is not an activated project virtualenv. User-level
package installation must remain writable and executable through the configured PATH.

OS packages remain substrate-dependent. This is not a promise of byte-for-byte reproducible builds.
Explicitly changing `osRefresh` requests a new base build without changing tool versions.

## Build-local hashes

The tooling uses an installation-input hash to name staged bundles and check that a retained native
artifact belongs to the requested inputs. A separate build-trigger hash includes provider
orchestration changes so Terraform reruns the adapter when its implementation changes.

These are implementation details of building and retrying, not public image identities:

- They do not enter Worker configuration, callbacks, database records, or shared API types.
- There is no installed-package inventory digest or release ID.
- There is no registry of historical verification evidence.
- Build hashes do not determine runtime compatibility.

Packaging and hashing use the same installation file set, including runtime assets and file modes.
Cached bundles reject extra or altered files; caches, credentials, and unrelated source are not
uploaded. Build-only sources stay outside the installed payload.

## Provider boundaries

The common installer does not hide native SDK differences. Adapters retain their actual transport
and lifecycle behavior, including Modal eager image construction, E2B template build/spawn, Daytona
snapshot creation, Vercel upload/snapshot, and OpenComputer image construction.

Provider-specific CA/proxy configuration remains in the OpenComputer adapter. Vercel uses its Amazon
Linux/node24 substrate. Runtime user and path differences belong to the image being built.

Names supplied by Terraform are deterministic. A retry may restore and verify an existing named
artifact against the current installation inputs; it must not overwrite it or silently accept a
different build. Manual builds default to unique names. Temporary verification sandboxes are
terminated even when checks fail. Native artifacts remain available for investigation and explicit
operator cleanup.

## Verification

Every native build verifies a fresh restored artifact before returning its reference:

- Isolated Python runtime imports.
- Exact normalized versions for pinned executable tools.
- OpenCode health and plugin loading.
- code-server and ttyd startup.
- Chromium screenshot through agent-browser.
- Xvfb/Fluxbox/x11vnc/noVNC, including a WebSocket-to-RFB exchange.
- Writable runtime-user directories, offline user-global pnpm execution, and SCM helpers.

Diagnostic tool versions and capability results may appear in build logs. They are not a persisted
runtime contract. Vercel's optional video encoder difference remains explicit; core services are
required on every provider.

Native-amd64 CI covers Debian/non-root and Amazon Linux/root reference containers. Provider-native
verification remains necessary because reference containers cannot prove provider SDK behavior.

## Runtime and compatibility

Keep the existing runtime manifest and compatibility floors. Ready events and build completion use
the installed runtime version, not a version label injected by a newer Worker.

New images bake a small launch-environment file. The runtime applies only allowlisted build-owned
paths before starting services, preserving session tokens and secrets. Legacy artifacts without this
file retain their existing launch configuration.

There are no new D1 columns, callback fields, shared API fields, or base-release configuration. The
existing callback authentication, replay handling, finalization, and provider ownership checks are
unchanged.

## Deployment and rollback

Terraform continues to own deployment:

- Modal eagerly builds/verifies the sandbox image, then deploys functions using its native image ID.
- Vercel and OpenComputer retain managed snapshot names and existing manual-reference overrides.
- Daytona and E2B derive new names from installation inputs (E2B also includes CPU/memory settings).
  Their existing Worker bindings switch only after the new artifact is verified.

Unlike the prior in-place E2B template rebuild, the consolidated build uses a distinct alias. This
allows build-before-switch without replacing the template used by the old Worker. Operators
upgrading from versions predating direct E2B boot should first deploy the current compatible
launcher code before introducing these images.

Rollback uses the previous known-good deployment/configuration and retained provider artifacts.
There is no separate promote/rollback command or historical release lock. Failed builds do not
delete or replace the currently configured image. Provider artifact retention is still an operator
responsibility; never remove images referenced by saved sessions or prepared images.

## Prepared repository images: deliberately unchanged

A base toolchain update does not automatically invalidate prepared repository images or saved
session snapshots. Existing repository, runtime-generation, and rebuild policies remain in force.

After a dependency-only update, explicitly rebuild the affected repository/environment images
through the existing image-build workflow if they must pick up the update immediately. Do not bump
the minimum boot-compatible runtime merely to force a dependency refresh.

Automatic base-image refresh is a separate potential feature. If needed later, evaluate one opaque
base-image revision and a bounded refresh policy; do not reintroduce package inventories into
application contracts.

## Implementation and acceptance

1. Centralize dependency pins, frozen installation, and service checks.
2. Route all five provider builders through the shared package.
3. Preserve native retry/cleanup and artifact-owned launch behavior.
4. Wire build triggers and verified references through existing deployment settings.
5. Remove the earlier release/provenance subsystem and document explicit prepared-image refresh.

Acceptance:

- One dependency update changes one authoritative manifest/lock source.
- All five adapters use the same installation and verification contract.
- Missing/stale locks fail before native allocation.
- Failed verification cannot switch deployment references.
- No release registry, D1 migration, callback expansion, or inventory tracking remains.
- Existing prepared-image and session lifecycle tests continue to pass.
