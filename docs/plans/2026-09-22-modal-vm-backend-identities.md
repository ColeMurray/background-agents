# Modal and Modal VM: distinct backend identities

## Status and scope

Implementation authorized by the user on 2026-09-22; deployment is not authorized.

The user confirmed PR #2007 has never been deployed. This implementation starts from current main,
retains the runtime and reviewed Modal fixes, and omits all unpublished variant migrations and UI.
Mixed-backend selection remains a follow-up.

Prepared against PR #2007, local branch `fix-modal-docker-review-findings`, commit
`5764ad45ba417db73c226154464d5b141740a695`. Paths below are relative to the repository root. Recheck
the PR head, target branch, outstanding review findings, and migration history before coding.

This decision supersedes the earlier per-session `dockerEnabled` / artifact-variant design. The user
explicitly selected **deployment-wide backend selection now; mixed-backend selection later**. The
user also accepts that changing the deployment backend can orphan existing sessions and their
snapshots, as switching from Modal to another vendor already can. Seamless session migration is not
a requirement. This does not authorize silently reinterpreting incompatible images or forgetting
known resource-cleanup obligations.

## 1. Decision

Represent two compute offerings through the existing sandbox-provider contract:

| Backend ID | Display name | Execution environment   | Docker for user workloads    | Implementation                                     |
| ---------- | ------------ | ----------------------- | ---------------------------- | -------------------------------------------------- |
| `modal`    | Modal        | Existing gVisor sandbox | Not enabled by this offering | Shared Modal provider/client                       |
| `modal-vm` | Modal VM     | Modal VM                | Included                     | Same provider/client, immutable offering selection |

Keep `SANDBOX_PROVIDER` as the deployment-wide selector. Its default remains `modal`. Both
identities use the same Modal account, credentials, HTTP transport, app deployment, image-build
adapter, and shared lifecycle implementation. A separate identity is **not** a separate vendor,
duplicate provider class, mandatory second Modal app, or second Terraform module instance.

Use existing `provider` fields for the concrete compute backend. Do not rename every existing
provider type/column to `backend`, add a parallel `backend` column, or introduce a provider-family
registry. Documentation should distinguish a compute backend from its vendor where needed.

The important simplification is removing runtime selection from shared session settings and artifact
selection. Moving `modal-docker.ts` to a differently named shared file is not the solution.

### Invariants

1. `modal` retains the existing default launch behavior. `modal-vm` either launches the VM offering
   with its Docker-capable image or fails; it never falls back to gVisor.
2. A provider instance has one immutable identity. Calls cannot change it through settings, user
   environment variables, image metadata, or a mutable field on a shared client.
3. Prepared images are selected, registered, superseded, and cleaned up under their recorded backend
   identity. `modal` images cannot satisfy `modal-vm` lookups, or vice versa.
4. Scheduler, session routes, generic lifecycle policy, and image-build workflow do not know about
   Docker admission, VM resource defaults, or Modal runtime flags.
5. CPU and memory configure the outer compute allocation, not individual Docker containers.
6. Existing checkpoint/retirement fencing remains intact. A checkpoint is not proof of retirement.
   Preserve [ADR 0004](../adr/0004-sandbox-checkpoint-and-shutdown.md).
7. Backend switching has no continuity guarantee. Existing fail-closed provider checks remain;
   accepting orphaned sessions is not permission to report a successful restore from incompatible
   state.

### Explicit non-goals

- Per-session, repository, environment, child-session, or automation backend overrides.
- Session backend pinning, automatic cross-provider snapshot conversion, or migration UI.
- A general execution-profile, capability-negotiation, allocation-coordinator, or routing framework.
- Untying all compute provisioning from Terraform in this change.
- Separate provider identities for CPU sizes, Docker versions, or routine runtime/image releases.
- Moving the Open Inspect harness into Docker. Runtime, bridge, workspace, and interactive services
  remain on the VM host; Docker hosts user workloads.
- Certifying Docker support for other providers or altering their resource/lifecycle semantics.
- Automatically destroying old sandboxes, deleting their data, or deploying this plan.

## 2. Ownership and contracts

### 2.1 Provider composition

Extend the existing backend-name union with `modal-vm`. At the provider factory, construct the same
`ModalSandboxProvider` with an explicit immutable identity of `modal` or `modal-vm`. Require the
factory to pass the identity; tests and direct constructors must do the same. Compute `name` and
capabilities after identity assignment, avoiding field-initializer ordering bugs.

Keep this two-value type local to the Modal implementation, derived from the existing backend union
where practical. Do not expose `dockerEnabled`, `vmRuntime`, or a configurable launch profile on
`SandboxProvider`.

The image-build factory maps both identities to `ModalImageBuildAdapter`, passing the exact recorded
identity rather than normalizing both to `modal`. Client creation/cleanup must not require the VM
base image to be currently provisioned; launching a new VM does. This preserves cleanup after a
deployment changes its default backend or removes its VM launch image.

### 2.2 Modal-private wire contract

Use an explicit `sandbox_backend: "modal" | "modal-vm"` on Modal HTTP **create, restore, and
create-build** requests. This field is private to the Modal adapter/client and Python API; it is not
a public session-setting field. Both sides validate the finite set and reject unknown values.

- A missing request field defaults to `modal`, preserving ordinary older callers.
- Remove runtime selection through `sandbox_settings.dockerEnabled`. If an old request explicitly
  contains that removed setting, reject it with an actionable error instead of silently ignoring
  `true` and launching gVisor. Do not maintain two ways to select the runtime.
- Successful allocation responses carry `sandbox_backend`, derived from the actual launch/adoption
  path, not merely echoed from the request. Ownership validation must precede confirmation for an
  adopted allocation. Unknown response values are protocol errors.
- A `modal-vm` provider requires an exact `modal-vm` confirmation. Missing, mismatched, or malformed
  confirmation is an incompatible deployment response: clean up a known allocation and fail before
  returning it to a session or starting an image build. Record build allocation handles before
  confirmation so failed cleanup survives restart; binding is not authorization to start work.
- A `modal` provider accepts `modal` confirmation. For rolling upgrades, it may accept a legacy
  response lacking the field only if the old `docker_enabled` signal is absent or explicitly false.
  It must reject an explicitly VM/Docker response. Never permit this exception for `modal-vm`.
- Emit only `sandbox_backend`. Read legacy `docker_enabled` only when validating an old standard
  endpoint response; there is no outbound legacy shim.
- Cleanup failures preserve the resource identifier and error context for retry/reconciliation; do
  not claim that the allocation was retired. Do not start a build after failed confirmation.

This is an application-level launch confirmation, not hardware attestation. VM support is also
validated by the data-plane launch configuration and an explicitly authorized provider canary. The
ordinary runtime-generation compatibility floor remains a separate existing concern.

### 2.3 Resources

Retain generic `cpuCores` and `memoryMib` in existing sandbox settings. Remove Docker-specific
freezing, inheritance rules, and positive-resource requirements from the scheduler and session
routes. Existing generic settings resolution/persistence still determines user-requested resources.

Put the **Modal VM offering defaults** in one Python launch-policy module: preserve the current
product choices of 2 CPU cores and 4096 MiB. These are product defaults, not asserted Modal
minimums. An absent or null resource selects the selected backend's default; a positive explicit
value is honored. Validate finite CPU and positive integer memory at the Modal boundary, including
rejecting booleans. Preserve standard Modal's existing default behavior when resources are
unspecified.

Use one resource-to-SDK mapping for session create, restore, and VM build allocations. Do not
compose two independently generated dictionaries that overwrite the same `cpu`/`memory` keys.
Deployment verification should import the offering defaults rather than restating them. Tests may
assert explicit expected values; production code has one owner for defaults.

Image-build resource decision: preserve configured VM build sizing without passing the whole session
settings bag as a runtime selector. Replace the feature-added `ImageBuildPlan.sandboxSettings` with
an optional neutral `resources` value containing only `cpuCores` and `memoryMib`, projected from the
already-resolved scope settings. Reuse those field types, not an extensible execution-profile type.
Only the Modal adapter consumes it in this change. VM builds apply configured values/defaults;
standard builds retain their pre-feature sizing behavior. Do not incidentally change other backends
or invent a new build-resource settings UI.

No CPU/memory values belong in an artifact identity. This change does not promise that changing an
allocation's resources preserves running processes or makes an application snapshot consistent.

### 2.4 Images, snapshots, and deployment switching

Prepared images already have a provider dimension. Use `(scope, provider)` plus existing repository
fingerprints and runtime compatibility checks. Remove `artifactVariant` from the target, planner,
registration, lookup, reconciliation, and workflow contracts. Remove the extra snapshot-variant
projection from the session repository/lifecycle contract.

Keep recorded provider fields on existing build rows and shutdown receipts. Do not overwrite them
with the deployment's current choice. Recorded image-build cleanup must remain routable when
`SANDBOX_PROVIDER` changes. Existing provider-mismatch recovery checks must continue to reject an
incompatible receipt. No new per-session provider column is required for this scope.

Changing `SANDBOX_PROVIDER` is an operator cutover, not a migration. Old sessions may be unusable
and must not be described as resumable. This plan neither guarantees every legacy orphan is
identified nor introduces transparent continuity. Operators should drain/retire known active
allocations before switching when feasible; retain credentials/endpoints for outstanding cleanup.
Hard timeouts are a last bound, not proof that a predecessor is already stopped.

## 3. Implementation sequence and file map

Implement in the isolated PR worktree, preserving unrelated work. Rebase/update only through the
approved PR workflow; do not reset active checkouts. Keep the already-landed review fixes during the
rewrite. The phases below are reviewable commits, not independently deployable releases.

### Phase A — Establish identities and shared Modal construction

- `packages/shared/src/types/integrations.ts`: add `modal-vm` to the backend enum and existing
  resources/timeout capabilities. Remove feature-only Docker-setting capability plumbing when its
  callers are removed. Do not equate that UI-setting capability with actual Docker support
  elsewhere.
- `packages/control-plane/src/sandbox/provider-name.ts`, `provider-factory.ts`, and
  `providers/modal-provider.ts`: configure one implementation with the exact immutable backend ID;
  extend factory overloads and error/log identity consistently. Preserve HMAC transport and
  credentials.
- `packages/control-plane/src/image-builds/model.ts` and `provider-factory.ts`: add `modal-vm` to
  supported build identities and select the shared adapter using the recorded identity.
- Audit shared API schemas, node configuration, web provider parsing, fixtures, and all exhaustive
  provider switches. Distinguish compute backend IDs from vendor-specific bundle targets: a sandbox
  image bundle may still use target `modal` for both offerings because installation is shared.
- Extend the explicit Modal dashboard guards in `session/components.ts` and
  `session/sandbox-access.ts` for both identities, without adding a provider-family registry.
- Add factory/identity tests before changing orchestration. Unknown providers must still fail;
  missing configuration must still select ordinary `modal`.

### Phase B — Own VM launch behavior inside Modal

- `packages/control-plane/src/sandbox/client.ts` and `providers/modal-provider.ts`: implement the
  private request/response contract and confirmation/cleanup behavior for all three allocation
  paths.
- `packages/modal-infra/src/web_api.py`: validate the selector and removed legacy settings; derive
  response identity from launch results. Preserve existing authentication and request validation.
- Refactor `packages/modal-infra/src/sandbox/docker_launch.py` into a focused Modal launch-policy
  module (suggested name `launch_policy.py`), hiding image selection, VM runtime options, trusted
  Docker signal, and resource defaults. Internal Docker service names may remain Docker-specific.
- `sandbox/manager.py`, `sandbox/build_session.py`: share policy/resource mapping and immutable
  launch results; do not fork the lifecycle manager. Preserve explicit missing-image errors.
- Include the backend in deterministic allocation ownership/names or an equally strong local
  ownership discriminator. Replace the internal artifact-variant tag with an explicit backend tag.
  Do not adopt/terminate allocations solely by a guessed name or relabel old tags as newly verified.
  With accepted orphan semantics, no legacy-adoption fallback is needed.
- Keep trusted Docker enablement derived from provider policy, overriding untrusted environment
  values. Standard launches explicitly disable the Docker runtime service.
- Keep VM-specific deterministic adoption/retirement local. Do not expand all providers' generic
  interfaces to describe Modal lookup races.

**Mandatory preserved regressions from commit `5764ad45b`:**

1. Retried/racing adoption returns the original allocation's interactive access credentials. Never
   return newly generated credentials that were not installed; credential recovery failure is
   closed.
2. Incompatible image-build allocation responses are durably bound for cleanup, rejected before
   start, and cleaned up through the existing workflow/reaper. Malformed confirmation must not
   discard a valid allocation ID. Failed session cleanup carries the allocation ID to
   generation-pinned storage.
3. Orphan predecessor retirement is confirmed (`terminate(..., wait=True)` or equivalent proven
   completion) before a successor can be created. Pending/failed retirement cannot launch a
   successor.

### Phase C — Remove the cross-layer Docker/variant machinery

- Delete `packages/control-plane/src/sandbox/modal-docker.ts`; replace its necessary behavior with
  Modal-local tests, not another shared helper importing Modal policy into orchestration.
- Remove its imports and freeze/admission/variant branches in:
  - `src/scheduler/scheduler.ts`;
  - `src/routes/session-create.ts`, `session-child-spawn.ts`;
  - `src/session/initialize.ts`, integration-settings resolution, child spawn context/handler;
  - `src/sandbox/lifecycle/manager.ts`, `src/sandbox/settings.ts`;
  - settings persistence/routes and image-build policy/planning/workflow modules.
- Remove `dockerEnabled` from shared sandbox settings, session-create/override types, and public API
  forwarding. New API writes containing it receive a targeted validation error; scope that check to
  actual settings containers rather than recursively banning the string in arbitrary user data.
- Remove special child CPU/memory inheritance introduced only to freeze Docker mode. Retain the
  pre-existing generic child/session settings policy and add regressions demonstrating it.
- Remove `snapshot_artifact_variant` read/write arguments from session ports, repository, shutdown,
  and lifecycle policy. Preserve all generation, receipt-provider, checkpoint, and retirement
  checks.
- Pass existing predecessor IDs as neutral create/restore context regardless of backend. The Modal
  VM provider owns deterministic retirement; generic lifecycle never interprets a Docker flag.
- Do not spread `if (provider === "modal-vm")` into these modules. Provider composition, config
  validation, and provider-specific adapters are the places allowed to discriminate.

### Phase D — Simplify the complete image-build flow

- `src/image-builds/{scope,planner,types,workflow,scheduler,lookup,provider-policy}.ts`: remove
  variant selection, Docker admission, variant race checks, and `modal-docker-v1` literals. Keep
  registration, secrets invalidation, callback authentication, runtime floors, timeouts, and source
  cleanup.
- `src/image-builds/modal-adapter.ts` and Modal trigger config: pass only neutral resource requests;
  backend selection comes from the constructed provider. Keep create-bind-confirm-start ordering;
  bind records cleanup responsibility, not readiness.
- `src/db/image-builds.ts`: remove active variant arguments/columns from queries and row models,
  after the migration strategy below is satisfied. Retain backend predicates on lookup, in-flight
  deduplication, completion, and supersession.
- Prove independent `modal` and `modal-vm` rows can exist for the same scope without either being
  selected as or superseding the other. A scope-wide secrets/config invalidation may intentionally
  invalidate both; do not replace that safety rule with provider-only invalidation.
- Verify callback/finalization/cleanup route by the build's stored provider, not the deployment
  default. Switching the default must not reinterpret an in-flight build as the new backend.

### Phase E — Remove toggle UI and simplify deployment configuration

- Remove `packages/web/src/components/docker-mode-select.tsx` and its feature-only wiring in
  settings, composer, create-session API forwarding, and warm drafts. Retain generic CPU/memory
  inputs for both Modal offerings. Show `Modal VM` where the application displays a backend label;
  do not add a session/backend picker in this change.
- `terraform/environments/production/variables.tf`: accept `modal-vm` and apply Modal credential
  validations to both identities. Remove the public `provision_modal_vm_sandboxes` and
  `enable_modal_vm_sandboxes` inputs introduced by this PR.
- `locals.tf`: treat both IDs as Modal-family provisioning. Derive VM-image provisioning from
  `sandbox_provider == "modal-vm"`. Keep the same module address/count for switching between them.
- `modal.tf`, `terraform/modules/modal-app/`, and deployment script: pass the derived need to build
  the verified VM image. A private build flag is fine; it is not an independent operator selection.
  Keep one app and the common base image; VM builds extend that image with Docker.
- `workers-control-plane.tf`, `src/types.ts`, `src/node/config.ts`: remove
  `ENABLE_MODAL_VM_SANDBOXES`; propagate the exact `SANDBOX_PROVIDER` consistently to server and UI.
  Keep the existing worker dependency on the Modal deployment module.
- `.github/workflows/terraform.yml`: remove both old VM flag mappings from plan and apply jobs;
  backend identity alone drives provisioning. Update workflow-contract and Terraform tests.
- `.env.example`, deployment examples, and getting-started/provider docs: document the two
  offerings, one selector, resource defaults, failure behavior, cleanup obligations, and unsupported
  continuity. Node deployments select the same backend but must provision compatible Modal endpoints
  themselves.
- `packages/modal-infra/deploy.py` and `src/images/base.py`: reuse the provider-local resource
  defaults in VM verification. Fail deployment if a required VM image was not built/verified. Do not
  let an old cache record stand in for the requested current image. Do not automatically delete old
  images.

## 4. Persistence and compatibility strategy

**First determine whether the existing feature has actually been applied anywhere.** An open PR or
local migration file is not proof that it has or has not been deployed. Record the answer per target
environment before choosing a migration strategy. No live data changes are part of writing this
plan.

### Preferred case: feature migrations/settings never deployed

- Remove PR-only D1 migration `0081_image_build_artifact_variant.sql`, provided it is unpublished
  and unapplied in every supported environment. Do not renumber unrelated migrations.
- Remove the PR-only session schema addition/migration for `snapshot_artifact_variant` where safe.
- Remove feature-only schemas/tests/fixtures; retain old ordinary Modal image rows under `modal`.
- No data backfill or session-provider pinning is needed. Existing provider columns are text; check
  application enums and any actual database constraints rather than assuming the enum update
  suffices.

### If an environment used the variant feature

- Preserve applied migration history. Leave obsolete columns unused initially; dropping them is not
  needed to remove the abstraction from the active code. Add a forward-only migration/runbook for
  that deployment instead of modifying an applied migration or rebuilding all tables unnecessarily.
- Before releasing queries without variant filtering, stop old writers and drain or fail legacy
  in-flight variant builds. Mark legacy VM/unknown-variant artifacts unselectable using existing
  failed/superseded lifecycle states, preserving image IDs, allocation IDs, and cleanup metadata.
  Block late callbacks from restoring their readiness. Ordinary `default` Modal artifacts may
  remain.
- Do **not** convert `provider=modal, artifact_variant=modal-docker-v1` to `provider=modal-vm` and
  call it verified. Rebuild under the new confirmed backend identity. Accepted session orphaning
  does not make mislabeled prepared images safe.
- Remove only the obsolete `dockerEnabled` property from known global/repository/environment
  settings locations through a scoped, tested migration or operator edit. Preserve explicit CPU,
  memory, timeout, and unrelated settings. Existing session records need not be migrated for
  continuity; do not keep interpreting their old flag as a backend override.
- Inventory stale browser drafts and API clients. Drop the obsolete property from restored local
  drafts; reject stale API writes with guidance to configure `SANDBOX_PROVIDER`, not an opaque
  error.
- Back up metadata before an authorized transition. Test the actual upgrade fixture, including
  cleanup and delayed callbacks. If old writers cannot be stopped, do not remove filtering yet;
  split a bounded compatibility transition instead of silently accepting incompatible images.

## 5. VM runtime safety and remaining review work

The identity split removes orchestration complexity; it does not itself prove Docker lifecycle
correctness. Reconcile every outstanding PR finding against the final head. The three original fixes
are preserved regressions; build recovery, probe isolation, and log hygiene are confirmed shipping
requirements in this change. Live Docker pause/resume is explicitly deferred.

VM session checkpoints remain **terminal**, but capture and retirement are separate operations. The
supervisor quiesces Docker over a local control socket, Modal captures the filesystem while the
source remains alive, and the control plane commits the image ID before it requests and confirms VM
retirement. Subsequent work restores into a new generation. Standard Modal checkpoints remain
nonterminal. This reuses the existing control-plane receipt-before-retirement ordering.

Review hardening preserves those boundaries:

- VM session generations share a provider-enforced allocation name, with exact generation ownership
  tags. A pending provider reference is stored before create/restore so snapshot and stop can
  resolve an allocation whose HTTP response was lost; this reference is not startup confirmation.
- VM captures use a distinct Modal endpoint that never retires the source or persists a
  provider-side receipt. It returns the immutable source ID, which the control plane persists
  alongside the image receipt and uses for retirement. A lost response leaves the source in place
  and the control plane holds the ambiguous outcome; a repeated capture can safely re-use Docker's
  idempotent preparation command. A capture without an acknowledged image ID never authorizes
  retirement. The older terminal endpoint and receipt lookup have been removed; any preexisting
  uncertain capture stays held rather than being replayed or retired automatically.
- Rejected allocations are durably fenced before awaited cleanup. Their explicit cleanup marker
  rearms retirement retries after restart without changing unrelated snapshot/recovery holds.
- Switching back to gVisor carries forward the currently deployed verified VM image through a
  private deployment handshake. It does not build another VM image or strip capability before the
  worker selector cutover. Removing that retained capability is a separate operator action, not an
  automatic side effect of switching compute offerings.

Validate these areas:

- **Checkpoint preparation:** current ordinary provider capture calls filesystem snapshot directly.
  Audit all ordinary and shutdown capture entry points against runtime Docker preparation. Require
  bounded container/daemon quiescence before a Docker filesystem is captured, followed by confirmed
  retirement for VM session captures. Build finalization already quiesces Docker and retires its
  source through the build workflow. Unknown outcomes stay fenced. Do not add live pause/resume
  machinery.
- **Build allocation recovery:** test loss of the create response before provider-session binding.
  Existing build ownership tags alone are not proof that create is idempotent. Make a deterministic
  owned build allocation discoverable to the existing unbound-source recovery/cleanup contract, with
  exact build identity checks; do not introduce a generic allocation framework.
- **Docker health checks:** ensure provider health checks target the local daemon despite user
  `DOCKER_HOST`, context, TLS, or related environment settings. Sanitize the probe environment
  without logging secrets or globally rewriting the user's workload environment.
- **Snapshot hygiene:** prevent daemon logs, stale credentials, and build-only auth material from
  being baked into reusable images. Test cleanup failures and verify no secret-bearing diagnostic
  output is exposed. Preserve host-runtime ownership and foreground daemon supervision.

These are verification/closure requirements for shipping the VM offering, not claims that every
listed defect remains present or instructions to expand the identity refactor without review. If an
item requires a significant new lifecycle protocol, isolate it as a prerequisite and report the
scope change. Do not mark the overall VM feature ready based solely on provider factory tests.

Snapshots preserve supported filesystem state, not process/RAM continuity or automatically
application-consistent databases. Document precisely which Docker state the canary actually proves.

## 6. Validation plan

### Automated coverage

| Boundary                     | Required evidence                                                                                                                                                                                                             |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity/configuration       | Missing selection is `modal`; `modal-vm` parses everywhere; invalid values fail; both use shared Modal credentials and the correct name/capabilities.                                                                         |
| Sessions/children/automation | Scheduler and create/child paths contain no Docker policy; existing generic settings still work; no public runtime override can alter the deployment choice.                                                                  |
| Modal create/restore/build   | Exact backend selector and launch kwargs; correct base/prebuilt image; trusted Docker signal; VM missing-image failure; explicit/custom/null/default resource cases.                                                          |
| Rolling deployment           | Old endpoint ignoring new fields fails closed for every VM allocation path; known allocations cleaned up; cleanup failures observable; legacy standard responses retain compatibility.                                        |
| Allocation races             | Owned adoption preserves credentials; wrong-owner/backend allocations cannot be adopted or retired; predecessor wait gates successor; lost build-create response can be reconciled.                                           |
| Image build lifecycle        | VM confirmation precedes start; handles are bound first for durable cleanup; both backend rows coexist; lookup/supersession/dedupe partition correctly; callbacks and cleanup still use recorded backend after config change. |
| Persistence                  | Fresh schema works without variant fields; applied-feature upgrade fixture cannot expose legacy VM artifacts as standard; late callbacks cannot reactivate quarantined builds.                                                |
| Snapshot/lifecycle           | Existing receipt-provider and generation checks survive; quiescence and unknown-outcome behavior are tested at the assembled lifecycle boundary, not only helper level.                                                       |
| Runtime/UI                   | Local Docker probe isolation, Docker startup/stop/hygiene; toggle absent; restored drafts cleaned; generic resource inputs and ordinary Modal behavior retained.                                                              |
| Terraform/workflows          | Both IDs provision the same Modal app; only VM selection requires VM image verification; plan/apply env mapping agrees; switch does not accidentally replace the app; other providers unchanged.                              |

Run targeted regressions first, then the relevant full suites. Build shared before dependent checks:

```bash
npm run build -w @open-inspect/shared
npm run typecheck -w @open-inspect/control-plane -w @open-inspect/web
npm test -w @open-inspect/control-plane
npm run test:integration -w @open-inspect/control-plane
npm test -w @open-inspect/web
npm run lint -w @open-inspect/control-plane
```

From each Python package (`packages/modal-infra`, `packages/sandbox-runtime`, and
`packages/sandbox-images`), run its supported test/lint commands in the project environment,
including `pytest tests/`, `ruff check`, and `ruff format --check`. Run the repository's Terraform
mock/contract tests, validate the affected Terraform, and check formatting of changed files. Confirm
installed tools and package scripts before constructing exact commands; avoid live deploy hooks in
validation. Record exact-head pass/fail evidence and distinguish pre-existing failures from new
ones.

### Structural acceptance checks

- Search executable shared/orchestration code for `modal-docker`, `artifactVariant`,
  `snapshot_artifact_variant`, `modal-docker-v1`, and Docker admission helpers: no active policy
  remains. Applied migration history, explicit legacy-input rejection, and upgrade fixtures are
  documented exceptions, not reasons to keep the concept in new contracts.
- Search `dockerEnabled`: no new persisted session setting or runtime selector remains. Provider
  response compatibility and targeted legacy validation must be named/documented exceptions.
- Search `modal-vm`: occurrences in generic scheduler/session lifecycle logic need justification;
  expected homes are provider registries, composition/configuration, adapters, tests, and
  documentation.
- No duplicated Modal provider/lifecycle implementation, mutable client mode, speculative routing
  framework, or new session backend pinning.
- Every removed safety check has a replacement invariant/test or an explicit accepted non-goal; do
  not erase runtime/version/ownership safeguards along with variant plumbing.

## 7. Rollout, canary, and rollback

Implementation and deployment are separate approvals. Do not run billable Modal allocations,
Terraform apply, remote data migrations, or production cleanup simply to finish the code change.

For an authorized rollout:

1. Determine the persistence case in section 4. Record known active sessions/builds, cleanup
   obligations, old/new image IDs, endpoint deployment revision, and selected backend without
   secrets.
2. Deploy the compatible Modal API and verified required image first. Keep the existing worker
   dependency ordering; independently deployed node workers must follow the same ordering.
3. For a cutover from an already deployed variant feature, stop old writers and perform the approved
   scoped metadata/settings transition before removing variant filters. Do not run old/new writers
   concurrently against ambiguous legacy artifact rows.
4. Deploy control plane/UI with the explicit backend selection. `modal` is the default; selecting
   `modal-vm` is the operator's opt-in. A missing/old VM endpoint must surface a clear failure.
5. On an authorized staging deployment, exercise a fresh VM session, a prepared-image build and
   session launch from it, IDE/VNC credentials after adoption, ordinary checkpoint/restore, and
   confirmed shutdown/replacement. Prove a user Docker container can run and persist the specific
   filesystem state promised. Inspect cleanup after intentional launch/confirmation failures.
6. Independently exercise standard `modal` with no VM option/Docker service, plus image build and
   restore. Record concrete allocation/runtime evidence; mocks alone do not prove provider behavior.
7. Observe launch failures, unexpected runtime confirmations, cleanup backlog, duplicate
   allocations, build completion, and leaked resources under each distinct backend label.

Rollback selects `modal` and deploys a compatible control plane/data plane, or restores the prior
known-good application version subject to the migration constraints. It is **not** transparent VM
session failover. Do not repurpose VM artifacts as standard images, revert applied migrations, or
remove cleanup credentials/endpoints while recorded resources still need reclamation. If restoring
the old variant implementation after a data transition, reconcile its writers/settings/artifact
expectations explicitly; a code rollback alone is insufficient.

## 8. Follow-up: mixed selection without restoring variants

When mixed workloads become an actual requirement, retain these same concrete backend IDs. Add a
neutral selection policy (for example automation/repository default plus an authorized session
override), resolve the backend once, and carry/persist that choice through session construction,
children, image selection, cleanup, and recovery. At that point define pinning and
configuration-change semantics deliberately. Provisioning both offerings can then be independent
from choosing the default.

That follow-up should route **to an existing provider instance/identity**, not recreate a
`dockerEnabled` flag that scheduler, images, and lifecycle must interpret. Cheap review workloads
and VM/Docker workloads can coexist without a new artifact-compatibility dimension. No selector,
pinning column, routing policy, or multi-offering Terraform interface is implemented speculatively
now.

## 9. Completion criteria and handoff

- Both backend identities work through one Modal implementation and the existing generic contracts.
- Active variant plumbing and session Docker-toggle scaffolding are removed, not renamed.
- Generic resources remain generic; Modal VM defaults and launch mechanics have a provider-local
  owner.
- Backend-specific artifacts cannot cross through lookup, late callbacks, rollout, or fallback.
- All three fixed review regressions remain covered, outstanding VM safety findings are reconciled,
  and relevant automated checks pass or have clearly documented baseline failures.
- Migration/deployment assumptions are explicit and verified before any rollout; accepted session
  orphaning is documented without claiming automatic retirement or continuity.
- Mixed selection is documented only as a follow-up. No production deployment or destructive cleanup
  is implied by code completion.
- Update the existing PR with the decision, removed concepts, test evidence, and rollout
  requirements when implementation is authorized. Do not resolve review threads merely because the
  plan mentions them; resolve against implemented and verified code.
