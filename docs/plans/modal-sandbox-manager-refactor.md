# Modal sandbox manager refactor

## Assessment

At base commit `232bb74c5`, `packages/modal-infra/src/sandbox/manager.py` is 722 lines. Its largest
responsibilities are launch translation and tunnel setup, not lifecycle operations.

| Responsibility                                                                  | Before                                          | Owner after refactoring                            |
| ------------------------------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------- |
| Configuration and returned sandbox records                                      | `SandboxConfig`, `SandboxHandle` in manager     | `models.py`; existing manager imports remain valid |
| Create/restore normalization, repository validation, operation logging          | `create_sandbox`, `restore_from_snapshot`       | `SandboxManager`                                   |
| Base/repository/snapshot image resolution and missing-image classification      | `_launch_sandbox`                               | `SandboxLauncher`                                  |
| Environment precedence, reserved keys, session serialization, VCS compatibility | `_launch_sandbox`                               | `SandboxLauncher`                                  |
| Credentials, resource translation, Modal creation, handle assembly              | Password/resource helpers and `_launch_sandbox` | `SandboxLauncher`                                  |
| Service/extra-port ownership, retries, URL routing, tunnel-file publication     | Six networking helpers plus launch assembly     | `SandboxTunnels`                                   |
| Bounded filesystem snapshot capture                                             | `take_snapshot`                                 | `SandboxManager`                                   |
| Provider lookup and confirmed termination                                       | `get_sandbox_by_id`, `stop_sandbox`             | `SandboxManager`                                   |

### Structural problems

- **Divergent change:** provider image, environment, networking, and lifecycle changes all require
  editing the same class. Extract the substantial launch and networking decisions.
- **Duplicated knowledge:** exposed service ports are reconstructed for URL resolution. Compute
  ownership once and use it for exposure, runtime environment, and returned URLs.
- **Leaky interface:** tunnel setup requires nine arguments and returns an anonymous tuple. Bind the
  launch's port configuration to one object and return named URL fields.
- **Dependency direction:** moving collaborators without moving shared records would make them
  import their manager. Put configuration and handles in a dependency-leaf module.

## Implementation plan

1. Establish the existing Modal test-suite baseline.
2. Move configuration/handle records to `models.py`, explicitly preserving public manager exports.
3. Extract `SandboxTunnels`. Its constructor resolves port ownership; `environment` and
   `exposed_ports` describe the launch; `resolve` handles best-effort URL resolution/publication.
4. Extract `SandboxLauncher`, retaining one shared launch path and the existing typed image-source
   variants. Keep image failures, credential generation, and environment precedence unchanged.
5. Retain create/restore normalization, snapshots, lookup, and termination in `SandboxManager`.
6. Migrate existing tests to the owning modules and exercise the complete manager/launcher/tunnel
   path with only provider I/O mocked.
7. Run the complete Modal suite, Ruff lint/format, a base-versus-head MyPy comparison, and PR CI.

The dependency direction is `manager -> launch -> tunnels`; manager and launch also use `models`.
Collaborators never import the manager. No generic provider interface, registry,
dependency-injection framework, or new lifecycle authority is introduced.

## Compatibility and verification

- Preserve all five public manager method signatures and configuration/handle fields.
- Preserve fresh/repository/snapshot environment rules, unknown session-config fields, legacy
  restore credentials, generated passwords, resource settings, and image-error classification.
- Preserve partial tunnel results, retry delays, non-fatal file-write failures, disabled-service
  port ownership, and raw-VNC exclusion from extra tunnels.
- Preserve snapshot deadline rounding/capping and wait-for-termination behavior.
- Keep existing logger names and event identifiers.
- Verify no fallback image or automatic spawn retry is introduced by error handling.
- This is a provider-local refactor; it does not change the control-plane lifecycle policy, runtime
  protocol, deployment configuration, or image-build sandbox service.
- Mocked provider tests establish translation and orchestration behavior, not live Modal behavior.
  No production deployment or billable provider canary is part of this change.

## Simplification Analysis

### Core Purpose

Separate launch translation and networking from existing-sandbox lifecycle operations.

### Unnecessary Complexity Found

- The old tunnel helpers repeated service-port selection and passed that knowledge between methods.
  `SandboxTunnels` now owns the selection and its consumers.

### Code to Remove

- Remove the manager's networking helpers and embedded launch implementation by extracting their
  actual responsibilities; do not retain private forwarding wrappers.
- Remove duplicated port reconstruction rather than adding another configuration layer.

### Simplification Recommendations

1. Keep the small snapshot, lookup, and termination operations in the manager.
2. Keep the existing common launch path and typed image variants.
3. Use concrete collaborators and named results, with no speculative extension points.

### YAGNI Violations

None introduced. Small lifecycle operations do not warrant additional service classes.

### Final Assessment

`manager.py` is 264 lines after refactoring: 458 fewer lines (63% smaller). The two collaborators
are 225 and 213 lines; shared records occupy 53 lines. Across these four production files, the total
grows by 33 lines for module boundaries, explicit exports, and the named tunnel result. Complexity
is low; proceed with this split.
