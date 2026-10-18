# Slice 4 report: native Pi Durable Code Mode

## Outcome

Connected Pi Durable 1.3's native `createCodemodeExtension()` to the separately deployed
`CodemodeSandbox` Worker through `RemoteCodemodeSandbox`. The feature defaults off and requires the
explicit `paid` mode because Cloudflare bills each execution as a Durable Object request and bills
wall-clock duration while scripts wait on tools. Production admission is not claimed ready:
Terraform also requires a disposable paid-account canary proof unavailable in this repository.

## Capability and policy

- Capability-era sessions durably latch workspace and Code Mode in one SessionDO-owned snapshot at
  creation, and Pi initialization completes before creation succeeds. Unopened legacy Pi state
  without a snapshot opens all-off; already-open state keeps its durable snapshot.
- Open-Inspect tools consume the shared effect classification contract. A mandatory
  `ToolTask.beforeTool` hook permits replay-safe `read` and default-denies unknown, unsafe, or
  effectful nested calls through the central extension assembler, without naming tools or
  conflicting with writable/repository/external-action branches.
- The native extension occupies the canonical `code_mode` slot and contributes
  `PI_CODEMODE_TOOL_EFFECT_REGISTRATIONS` to the composite policy registry.
- Model-powered globals remain registered for native replay compatibility; the composite policy
  denies their unsafe nested calls.
- The control plane uses the package's `/portable` runtime. The `/cloudflare` path is type-only and
  the build guard proves neither that runtime nor QuickJS WASM enters the control-plane bundle.

## Deployment and rollback

The dedicated Wrangler workflow is the sole owner of the private Worker, WASM, version, fixed CPU
limit, and migration. Terraform creates none of them; after explicit live verification it manages
only the retained external binding. Provider issues #6852 and #6404 remain open, so local
plan/workerd evidence is not live deployment proof. Rollback changes admission to `off` while
retaining `PI_SESSION`, the Worker, class, external binding, and installed extension. Fresh calls
are denied while they remain in Pi Durable's `call` phase. Recovery after Pi Durable has committed
its native `execute` intent bypasses `beforeTool` and follows the native replay contract; no
Open-Inspect Code Mode admission memo exists. Worker-version rollback also runs only through
Wrangler.

## Evidence

- Focused mode, latch, and mandatory policy unit tests.
- Real auxiliary-worker workerd tests for execution, deterministic replay, stable fingerprints,
  abort propagation, close behavior, and PiSessionDO teardown of active/interrupted scripts.
- A combined PiHarness → native extension → remote DO → authorized read test crosses a forced
  Durable Object restart and verifies the resumed transcript.
- Native `createCodemodeExtension()` SQLite tests for call-phase crash denial, execute-phase replay,
  completed nested-call reattachment, interrupted-call replay, and abort propagation.
- PiSessionDO workerd assertions for model/callable tools, legacy backfill, and durable latch.
- Terraform tests prove default plans create no sandbox migration/version and cover verified
  binding, paid readiness, rollback retention, and invalid modes.
- Bundle metafile assertions excluding the Cloudflare runtime and WASM from the control plane.
