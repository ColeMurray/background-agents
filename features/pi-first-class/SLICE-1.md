# Slice 1 report: isolated Code Mode sandbox infrastructure

## Outcome

Added a dedicated, private Cloudflare Worker that exports Pi Code Mode's official
`CodemodeSandboxDurableObject` under the stable `CodemodeSandbox` class name. Wrangler compiles the
QuickJS WASM import; Terraform uploads the JavaScript, source map, and WASM as one module Worker.

This slice does not bind the Worker to the control plane, install Code Mode in Pi, expose execution
to users, or give the sandbox credentials, application storage, service bindings, or a public URL.

## Deployment contract

- `workers.dev` and preview URLs are disabled.
- The `v1` class migration is deployed without a self-binding, avoiding provider issue #6852's
  create-and-bind-in-one-version failure.
- A deployed-version state check records migration completion on the following Terraform run.
- Optional custom CPU limits are validated and staged as numeric JSON; unset Free-plan deployments
  do not send an invalid `null` environment value or require a paid limit.
- Rollback keeps the Worker/class in place; runtime admission remains absent.

## Reusable Terraform support

- File-backed additional Worker modules, including WASM and source maps.
- External Durable Object namespace bindings with `script_name` and optional environment.
- Migration-only exported classes without unused namespace bindings.
- Nullable preview URL management, private workers.dev configuration, optional CPU limits, binding
  name collision checks, and safe module-name validation.

## Evidence

- Sandbox build: 754.20 KiB upload; normalized `quickjs.wasm` 637,405 bytes.
- Sandbox contract: 1 passed.
- Cloudflare Worker module contracts: 6 passed.
- Production Terraform contracts: 76 passed.
- Terraform workflow/comment contracts: 28 passed.
- Repository typecheck, lint, Prettier, Terraform fmt/validate, and README translations passed.
- Final security review: no concrete blockers.
- Issue #6852 re-review: its demonstrated failure requires a binding to the class created in the
  same undeployed version; this migration-only Worker has zero bindings.
