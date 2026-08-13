# Sandbox Runtime Entrypoint Refactor

## Scope

`packages/sandbox-runtime/src/sandbox_runtime/entrypoint.py` is the sandbox process entry point and
previously contained 2,523 lines. This document inventories its existing responsibilities, evaluates
separation options, and defines the implementation and test plan for reducing it to composition root
and lifecycle orchestration code.

The refactor must preserve runtime behavior for fresh boots, snapshot restores, repository-image
boots, image builds, and repository-less sessions. The module path
`python -m sandbox_runtime.entrypoint` remains stable for all providers.

## Current Responsibilities

### Process Entry

- Configure runtime logging at import time.
- Parse the gated Modal image-build command-line flag.
- Construct the supervisor and its shutdown event.
- Register `SIGTERM` and `SIGINT` handlers.
- Select regular supervision or the Modal image-build start protocol.

### Environment And Session Configuration

- Read sandbox identity, control-plane connection details, repository identity, VCS host, and
  session configuration from environment variables.
- Consume the VNC password before child processes can inherit it and configure `DISPLAY`.
- Derive workspace and primary repository paths.
- Parse and validate the ordered repository list.
- Detect fresh, snapshot-restore, repository-image, and build boot modes.
- Parse service ports, hook timeouts, tunnel expectations, and image-build deadlines.

### Repository Operations

- Build credential-free HTTPS clone URLs and redact credential-bearing URLs in Git errors.
- Install or repair the Git credential-helper shim and global Git configuration.
- Install the authenticated `gh` wrapper.
- Clone repositories, normalize remotes, fetch branches, and check out remote tips.
- Preserve restored worktrees while refreshing remote refs.
- Synchronize repositories concurrently and collect partial failures.
- Resolve and persist per-repository diff baselines.
- Read repository HEAD SHAs for image-build callbacks.
- Own subprocess cancellation and process-group cleanup used by Git and hooks.

### Repository Boot Policy

- Decide which synchronization failures are fatal for each boot mode.
- Run setup hooks for fresh and build boots.
- Run start hooks for all non-build boots.
- Apply primary-versus-secondary repository failure policy.
- Suppress hook output from build logs to reduce secret exposure.
- Return repository boot results used by startup telemetry and image-build callbacks.

### Workspace Assembly

- Write the machine-readable repository manifest.
- Generate the multi-repository `/workspace/AGENTS.md` instructions.
- Merge repository `.opencode` trees in configured order.
- Detect and report merged-file collisions as deferred boot warnings.
- Reset generated workspace state without deleting image-managed dependencies.
- Select the OpenCode and code-server working directory.

### OpenCode Filesystem And Authentication

- Install bundled tools, legacy PR tooling, skills, and standalone CLI scripts.
- Enforce tool environment gates and repository requirements.
- Stage image-built plugin dependencies into workspace and global config directories.
- Install Git excludes for runtime-owned files.
- Write control-plane-managed OpenAI and xAI OAuth sentinels atomically with secure permissions.
- Deploy managed-provider OpenCode plugins.

### MCP Configuration

- Read MCP server definitions from session configuration.
- Validate and pre-install packages used by local `npx` servers.
- Convert local and remote server definitions to OpenCode configuration.

### Core Runtime Services

- Start OpenCode with generated configuration and wait for its health endpoint.
- Start the control-plane bridge after OpenCode becomes ready.
- Start code-server when configured.
- Start ttyd and its authenticated proxy when configured.
- Forward and sanitize child-process log streams, including oversized and invalid UTF-8 lines.

### VNC Desktop Stack

- Securely encode and write the VNC password file.
- Remove stale display sockets and lock files retained by snapshots.
- Start Xvfb, Fluxbox, x11vnc, and noVNC in dependency order.
- Wait for display-path and TCP readiness.
- Restart the whole dependent stack when one component fails.
- Stop the stack in reverse order and remove password/display artifacts.

### Tunnel Coordination

- Parse expected tunnel ports.
- Distinguish a fresh manager-written tunnel file from stale snapshot state.
- Remove stale tunnel files based on the sandbox marker.
- Wait for expected `TUNNEL_<port>` entries before repository start hooks, with degraded timeout
  behavior. The current implementation does not validate URL contents, file ownership or mode, or
  every symlink case.

### Supervision And Shutdown

- Start boot phases in the required order.
- Treat optional sidecar failures as non-fatal.
- Monitor OpenCode, bridge, code-server, ttyd, ttyd proxy, and VNC processes.
- Apply bounded exponential restart policies and component-specific fatality rules.
- Propagate a graceful bridge exit to sandbox shutdown.
- Report fatal startup and runtime errors to the control plane.
- Race image-build work and callbacks against shutdown signals.
- Report image-build success or failure and remain alive for provider finalization.
- Stop every child process in dependency-aware order.

## Design Problems

- `SandboxSupervisor` has many reasons to change and violates the single-responsibility principle.
- Boot policy, domain operations, process mechanics, and provider protocol concerns are interleaved.
- Mutable process handles for unrelated services share one object.
- Environment reads are spread through methods, obscuring dependencies and making tests patch module
  globals.
- Tests frequently patch private methods and `entrypoint`-local imports instead of injecting
  collaborators, which makes safe extraction harder.
- Restart logic is duplicated for optional services, but the core services have materially different
  semantics, so a fully generic process abstraction would hide important policy.
- The entry-point module is both a composition root and nearly the entire application.

## Options Considered

### 1. Move The Supervisor Unchanged

Move `SandboxSupervisor` to `supervisor.py` and leave `entrypoint.py` as a CLI facade.

Advantages:

- Very low regression risk.
- Immediately produces a small entry-point module.

Disadvantages:

- Merely relocates the 2,400-line class.
- Does not separate responsibilities or improve dependency direction.
- Does not satisfy the architectural goal.

### 2. Extract Domain Collaborators

Keep boot sequencing, process policy, and shutdown in `SandboxSupervisor`. Compose it from cohesive
collaborators for repository boot, OpenCode, and optional sidecars. Pass explicit configuration,
state, logging, and shutdown dependencies.

Advantages:

- Separates policy from mechanics without introducing a framework.
- Collaborators can be tested directly and replaced with fakes in lifecycle tests.
- Keeps service-specific restart semantics visible in the supervisor.
- Supports incremental extraction while preserving behavior.

Disadvantages:

- Requires deliberate migration of tests that patch private supervisor methods.
- Shared repository state and boot mode need a small, explicit representation.

### 3. Generic Managed-Service Framework

Represent every child process as a `ManagedService` implementing start, health, restart, and stop
protocols, then drive all services through one generic monitor.

Advantages:

- Removes repeated restart and shutdown code.
- Makes adding homogeneous sidecars straightforward.

Disadvantages:

- OpenCode, bridge, VNC, and optional sidecars are not homogeneous: they differ in readiness,
  dependency ordering, graceful-exit meaning, grouped-process behavior, and fatality.
- A framework would add protocols, state machines, callbacks, and policy flags primarily to make
  unlike things appear alike.
- Higher migration risk with little immediate product value.

## Selected Architecture

Use option 2 with three required collaborators: `RepositoryBootstrapper`, `CoreAgentServices`, and
`AccessServices`. `SandboxSupervisor` contains lifecycle policy only, and `entrypoint.py` is the
sole production composition root. Do not add optional production defaults, a container, service
locator, abstract base classes, protocols solely for tests, or a generic process framework.

### `runtime_config.py`

- `BootMode`: enum for `fresh`, `snapshot_restore`, `repo_image`, and `build`.
- `RuntimeConfig`: immutable values that are stable from process start, including identities,
  control-plane details, session configuration, and workspace paths.

`RuntimeConfig.from_env()` accepts a mapping so tests can construct configuration without patching
global `os.environ`. There is no general path bag: writable protocol paths are injected individually
into their owners, while bundled asset locations remain module constants. Launch-protocol secrets
and the VNC password are consumed at the composition or protocol boundary and are never stored in
broad shared configuration.

Environment migration follows this ownership table:

| Category                | Examples                                                                     | Read policy                                                                                                                                                    |
| ----------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Startup-frozen identity | `SANDBOX_ID`, repository identity, `VCS_HOST`, control-plane URL             | Parse once into narrow configuration                                                                                                                           |
| Startup-frozen session  | `SESSION_CONFIG`                                                             | Parse once and validate before collaborator construction                                                                                                       |
| Boot selection          | `IMAGE_BUILD_MODE`, restore/image markers                                    | Parse once immediately before lifecycle dispatch                                                                                                               |
| Operation-time settings | Hook/tunnel/build timeouts, service ports and gates, OAuth/plugin/tool gates | Preserve current operation-time reads during this refactor                                                                                                     |
| Consume-once secrets    | VNC password and gated image-build callback token                            | Remove at the current protocol boundary before unrelated child processes start                                                                                 |
| Child credential        | `SANDBOX_AUTH_TOKEN`                                                         | Pass only to the bridge and control-plane error reporter; narrowing other child environments is a separate security change unless required to avoid regression |

### `repository_boot.py`

- `RepositoryBootstrapper` owns repository parsing and validation, credential setup, Git
  synchronization, baseline resolution, hook execution, tunnel coordination, boot warnings, the
  repository manifest, and the generated workspace `AGENTS.md`.
- `BootstrapResult` includes the resolved immutable repository list, selected workdir, repository
  SHAs, and setup/start/sync outcomes. The collaborator owns mutable state only while coordinating a
  boot and returns an immutable repository snapshot to downstream services.
- The collaborator receives repository configuration, logger, and the shared shutdown event.
  Subprocess and protocol-path tests patch their defining module rather than the CLI module.
- Fatality policy stays here only where it is inherently repository-boot policy: boot-mode sync
  handling and primary/secondary hook handling.

### `core_services.py`

- `CoreAgentServices` owns OpenCode-specific workspace assembly, tools/skills/bin/dependency
  installation, managed OAuth and plugins, MCP translation/package installation, OpenCode process
  mechanics, and bridge process mechanics.
- It receives the resolved repository list and workdir at startup rather than reading supervisor
  fields implicitly.
- It exposes explicit OpenCode and bridge start, stop, and status operations. OpenCode startup does
  not return until health succeeds, so it does not expose a mutable readiness event.
- Restart limits, backoff, fatality, and graceful bridge-exit meaning remain in the supervisor.

### `access_services.py`

- `AccessServices` owns code-server, ttyd, ttyd proxy, and the VNC stack because all are optional,
  best-effort sandbox access services.
- It receives sandbox workspace configuration, the consumed VNC password value, logger, and the
  shared shutdown event. Process and VNC-path tests patch their defining module.
- It exposes explicit service operations and status. It does not own retry counters, backoff,
  fatality, or a generic `restart()` API.
- VNC remains a grouped stack with its startup, readiness, secret-file, and reverse-shutdown
  invariants intact.

### `supervisor.py`

- `SandboxSupervisor` owns phase ordering, image-build protocol integration, restart/fatality
  policy, startup telemetry, control-plane fatal reporting, shutdown racing, and coordinated
  shutdown.
- Constructor parameters require all collaborators. Production construction occurs only in
  `entrypoint.py`; tests inject fakes.
- The supervisor does not directly spawn child processes.
- The monitor remains explicit so bridge exit semantics, OpenCode fatality, optional-sidecar
  degradation, and VNC grouped restarts are readable.
- Shared log streaming and owned-subprocess helpers move only if two collaborators actually need
  them. Prefer small module functions over a utility class.

### `entrypoint.py`

- Configure logging.
- Parse arguments.
- Consume process-level secrets and build the stable runtime configuration.
- Construct collaborators and the supervisor.
- Install signal handlers.
- Dispatch regular or gated image-build execution.
- Preserve `python -m sandbox_runtime.entrypoint`, CLI arguments, signal behavior, and exit codes.
  Internal tests move to defining modules; exports are retained only for concrete non-test users.

## Dependency Direction

```text
entrypoint
  -> runtime_config
  -> repository_boot
  -> core_services
  -> access_services
  -> supervisor

supervisor
  -> runtime_config
  -> repo_image_callback

repository_boot / core_services / access_services
  -> constants and focused existing helpers
```

The supervisor accepts collaborators by duck typing but does not import or construct their concrete
classes. Test doubles implement only the operations they exercise; adding `Protocol` definitions is
deferred until static typing or a second production implementation demonstrates the need.

## Implementation Sequence

### 1. Characterize Behavior And Security Boundaries

- Add tests that construct `SandboxSupervisor` with fake repository, core-service, and
  access-service collaborators.
- Assert regular boot phase ordering and build-mode exclusion of runtime services.
- Assert supervisor decisions for fatal core-process failures and non-fatal optional-service
  failures without patching private methods.
- Record a compatibility matrix for fresh, snapshot, repository-image, build, and repository-less
  boots, including single- and multi-repository variants.
- Add regression coverage that consume-once secrets are not broadened into collaborator state or
  unrelated child environments. Security hardening beyond current behavior remains separate.

### 2. Extract Repository Bootstrap

- Move Git, hook, warning, tunnel, manifest, and repository boot-result behavior together.
- Migrate existing tests to instantiate `RepositoryBootstrapper` directly and patch subprocesses and
  owned paths in `sandbox_runtime.repository_boot` instead of the entry-point module.
- Preserve integration tests that exercise a real Git repository.
- Verify every boot-mode failure policy before proceeding.

### 3. Extract Optional Access Services

- Move code-server and ttyd/proxy behavior.
- Move VNC as one cohesive stack.
- Add missing focused tests for ttyd proxy startup and ttyd/proxy restart behavior.
- Preserve password-file mode, symlink protection, localhost binding, startup order, grouped
  restart, and reverse shutdown tests.

### 4. Extract Core Agent Services

- Move workspace assembly and runtime asset preparation first, retaining existing focused tests.
- Move managed OAuth, MCP, OpenCode launch/health/logging, and bridge mechanics next.
- Add a single start test that verifies generated config, workdir, installed assets, and process
  launch wiring; retain focused security tests for OAuth file mode and npm package validation.

### 5. Introduce Required Composition And Reduce The Supervisor

- Move orchestration to `supervisor.py`.
- Replace direct process construction with collaborator calls.
- Keep explicit monitor branches and current restart limits/backoff behavior.

### 6. Extract Stable Configuration Last

- Add `BootMode` and `RuntimeConfig` parsing tests.
- Migrate only startup-frozen values from the environment ownership table.
- Keep operation-time reads unchanged and keep milliseconds/seconds naming aligned with project
  conventions.

### 7. Reduce The Entrypoint And Test Coupling

- Reduce `entrypoint.py` to the composition root and CLI.
- Update tests to patch defining modules or inject dependencies.
- Preserve provider module invocation without class re-exports or private forwarding methods.

## TDD And Verification

For each extraction:

1. Add or move focused tests to describe the collaborator contract.
2. Run the focused test and confirm the expected failure when introducing a new seam.
3. Implement the smallest behavior-preserving change.
4. Run all tests that cover the moved responsibility.
5. Run the full sandbox-runtime test suite before starting the next extraction.

Final verification:

```bash
cd packages/sandbox-runtime
pytest tests/ -v
ruff check src tests
ruff format --check src tests
mypy src

cd ../modal-infra
pytest tests/ -v
ruff check src tests
mypy src
```

The Modal tests are required because they launch `sandbox_runtime.entrypoint` for interactive and
image-build sandboxes. If repository-wide CI commands are affordable, run the root Python checks as
well.

## Acceptance Criteria

- `entrypoint.py` contains only logging setup, CLI parsing, composition, signal registration, and
  dispatch.
- Repository boot, OpenCode runtime, and optional sidecar behavior live in focused modules and are
  composed rather than inherited by `SandboxSupervisor`.
- Boot order and behavior are unchanged in all four boot modes and repository-less sessions.
- Image-build callback, timeout, and cancellation behavior is unchanged.
- The refactor does not broaden existing secret exposure; consume-once values are absent from
  unrelated collaborator state and child environments.
- OpenCode and bridge remain fatal after bounded restart exhaustion; optional sidecars remain
  best-effort.
- Existing runtime module invocation paths remain valid for Modal, Daytona, and E2B.
- Tests primarily exercise collaborators through constructor injection rather than patching private
  supervisor methods or `entrypoint` module globals.
- Sandbox-runtime and Modal-infra tests, lint, formatting, and type checking pass.

## Explicit Non-Goals

- Changing boot behavior, hook policy, ports, timeouts, or restart limits.
- Replacing subprocesses with an external process manager.
- Introducing a dependency-injection container.
- Designing a universal managed-service abstraction.
- Adding compatibility wrappers for private methods used only by tests.
- Refactoring bridge internals or provider-specific sandbox managers.

## Rollout

- Ship behavior-preserving extractions without a dual implementation or feature flag.
- Smoke-test fresh, snapshot, repository-image, build, and repository-less sessions, including one
  multi-repository session.
- Verify startup telemetry, warning delivery, callback success/failure, OpenCode and bridge
  recovery, optional-service degradation, and shutdown.
- Canary Modal first, then providers that use the same stable module invocation.
- Roll back by runtime image/version rather than adding compatibility branches inside the runtime.
