# Slice 1 report: isolated Code Mode sandbox infrastructure

## Outcome

Added a dedicated, private Cloudflare Worker that exports Pi Code Mode's official
`CodemodeSandboxDurableObject` under the stable `CodemodeSandbox` class name. Wrangler compiles the
QuickJS WASM import and directly owns the private Worker, version, WASM upload, and class migration.
Terraform never creates or adopts this Worker; it later manages only a verified external binding.

This slice does not bind the Worker to the control plane, install Code Mode in Pi, expose execution
to users, or give the sandbox credentials, application storage, service bindings, or a public URL.

## Deployment contract

- `workers.dev` and preview URLs are disabled.
- The dedicated manual workflow invokes Wrangler with a deterministic deployment-scoped name.
- One direct deploy owns the QuickJS WASM and `v1` SQLite migration with zero self-bindings, routes,
  preview URLs, variables, secrets, or service bindings.
- The CPU limit is fixed at 60000 ms and requires live paid-account verification.
- Fresh deploys and upgrades use Wrangler deploy; version rollback uses Wrangler rollback.
- Terraform's explicit verified-deployment input adds only the retained external binding.

## Terraform boundary

- External Durable Object namespace bindings with `script_name` and optional environment.
- A `removed` block forgets preview-era module state with `destroy = false` so Terraform does not
  delete the Worker while ownership moves to Wrangler.
- Normal Terraform plans contain no Code Mode Worker, version, WASM, or migration resource.

## Evidence

- Sandbox build: 754.20 KiB upload; normalized `quickjs.wasm` 637,405 bytes.
- Sandbox contract: 1 passed.
- Cloudflare Worker module contracts: 6 passed.
- Dedicated Wrangler owner contracts cover deterministic deploy/upgrade/rollback commands.
- Production Terraform contracts prove default plans create no sandbox lifecycle resources.
- Repository typecheck, lint, Prettier, Terraform fmt/validate, and README translations passed.
- Final security review: no concrete blockers.
- Provider issues #6852 and #6404 remain live-canary concerns; local contracts do not infer provider
  behavior from their titles.
