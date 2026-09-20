# Docker on Modal VM Sandboxes

Modal sessions use the existing gVisor sandbox by default. Select **Docker (Modal VM)** when a
repository needs Docker Engine, Buildx, or Compose. This is an opt-in execution profile within the
Modal provider, not another provider.

## Choose an execution mode

The session creation selector offers inherited settings, Standard, and Docker. Global, repository,
and environment Sandbox settings can also set a default; environment settings override repository
settings. Explicit Standard overrides an inherited Docker requirement.

API callers can pass `dockerEnabled: true` or `false` to session creation. Omit the property to
inherit; `null` and string booleans are invalid. Unsupported providers, denied repository scopes,
and closed admission fail explicitly rather than falling back to gVisor.

The resolved profile, provider, CPU, and RAM are fixed for the session. Docker defaults to 2 CPU
cores and 4096 MiB RAM; configured resource values override those defaults. Resource needs depend on
your workload. Child sessions inherit the parent's execution contract but still need current
permission to create new Docker sessions.

## Run Docker workloads

The runtime starts a VM-local Docker daemon before repository hooks. Use normal `docker build`,
`docker run`, and `docker compose` commands. There is no public Docker API socket. Configure
`tunnelPorts` for application ports published by containers; Docker publishing alone does not add an
Open-Inspect tunnel. Avoid Compose subnets overlapping your network.

Start hooks must be idempotent: after filesystem restore, Docker restart policies can start saved
containers before a hook runs. `restart: always` and `unless-stopped` resumed running containers in
the qualification fixture; `restart: "no"` did not. Hooks should reconcile desired services rather
than assume every container is absent.

Snapshots preserve the filesystem, including workspace changes, local Docker images, and named
volumes. They do **not** preserve process/RAM identity or guarantee transactional database backups.
Flush/export application data explicitly when consistency matters. External storage and tmpfs are
outside this guarantee. Registry credentials, build arguments, layers, and volumes can contain
secrets; prefer temporary Docker authentication and BuildKit secret mounts.

Prepared repository images use the same profile. Their daemon is cleanly stopped before reporting
build success; the finalizer snapshots that prepared filesystem. Setup hooks must await Docker work
and must not leave background writers running.

## Snapshot recovery

An incompatible or missing Docker snapshot blocks automatic replacement. The session retains its
snapshot reference and displays a recovery reason. After operator repair, **Retry the existing
snapshot** attempts only that artifact and profile; it does not accept a replacement image. The
recovery condition clears only when the replacement runtime reaches ready.

A deleted/expired artifact may be unrecoverable. **Create a separate new session** starts clean,
without the original workspace or volumes, and leaves the old reference intact.

## Operator enablement and rollback

1. Apply additive D1 and Session-storage migrations, keeping admission off.
2. Set Terraform `provision_modal_vm_sandboxes=true` to build and verify both native images and
   deploy profile-aware Modal endpoints. For manual Modal builds, use `BUILD_MODAL_VM_IMAGE=true` or
   `uv run python deploy.py --build-sandbox-image --with-docker` in `packages/modal-infra`.
3. Deploy the profile-aware control plane and web application. Qualify an isolated canary before
   setting Terraform `enable_modal_vm_sandboxes=true` (control-plane environment variable
   `ENABLE_MODAL_VM_SANDBOXES=true`). Keep the global user default off unless intentionally changed.
4. To roll back new admission, set only `enable_modal_vm_sandboxes=false`. **Keep provisioning,
   Modal credentials, endpoint support, and compatible runtime binaries available** for previously
   admitted sessions/builds. Do not roll back to a pre-feature binary or switch existing Docker
   sessions to another provider.

Modal SDK 1.5.5 is pinned. Product snapshots explicitly retain the existing indefinite-retention
behavior (`ttl=None`); monitor storage use. The prebuild reaper deletes retired provider images, not
snapshots retained for session recovery. Provisioned base-image references are protected from that
deletion endpoint.

Modal VM support remains beta. General rollout still requires representative repository, resource
pressure, and end-to-end deployed application qualification; native fixture success is not a
production workload guarantee.
