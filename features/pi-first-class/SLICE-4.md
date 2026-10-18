# Slice 4 report: native Pi Durable Code Mode

## Outcome

Connected Pi Durable 1.3's native `createCodemodeExtension()` to the separately deployed
`CodemodeSandbox` Worker through `RemoteCodemodeSandbox`. The feature defaults off and requires the
explicit `paid` mode because Cloudflare bills each execution as a Durable Object request and bills
wall-clock duration while scripts wait on tools. Production admission is not claimed ready:
Terraform also requires a disposable paid-account canary proof unavailable in this repository.

## Capability and policy

- Capability-era sessions durably latch workspace and Code Mode in one snapshot the first time Pi
  opens. Legacy Pi state without the eligibility marker backfills to all-off; later flags cannot
  widen it.
- Open-Inspect tools consume the shared effect classification contract. A mandatory
  `ToolTask.beforeTool` hook permits replay-safe `read` and default-denies unknown, unsafe, or
  effectful nested calls through the central extension assembler, without naming tools or
  conflicting with writable/repository/external-action branches.
- The native extension occupies the canonical `code_mode` slot and contributes
  `PI_CODEMODE_TOOL_EFFECT_REGISTRATIONS` to the composite policy registry.
- Model-powered Code Mode globals are disabled.
- The control plane uses the package's `/portable` runtime. The `/cloudflare` path is type-only and
  the build guard proves neither that runtime nor QuickJS WASM enters the control-plane bundle.

## Deployment and rollback

The sandbox migration deploys before the control plane receives its external binding. Terraform
rejects `paid` until the migration, a configured CPU limit, and a live paid-account canary are
recorded. Provider issues #6852 and #6404 remain open, so local plan/workerd evidence is not live
deployment proof. Rollback changes admission to `off` while retaining the Worker, class, binding,
and installed extension. New calls are denied before the durable admission memo; admitted tasks
retain that memo and replay.

## Evidence

- Focused mode, latch, and mandatory policy unit tests.
- Real auxiliary-worker workerd tests for execution, deterministic replay, stable fingerprints,
  abort propagation, close behavior, and PiSessionDO teardown of active/interrupted scripts.
- A combined PiHarness → native extension → remote DO → authorized read test crosses a forced
  Durable Object restart and verifies the resumed transcript.
- Native `createCodemodeExtension()` SQLite tests for journal replay, completed nested-call
  reattachment, interrupted-call replay, and abort propagation.
- PiSessionDO workerd assertions for model/callable tools, legacy backfill, and durable latch.
- Terraform tests for default-off, two-phase binding, paid readiness, rollback retention, and
  invalid modes.
- Bundle metafile assertions excluding the Cloudflare runtime and WASM from the control plane.
