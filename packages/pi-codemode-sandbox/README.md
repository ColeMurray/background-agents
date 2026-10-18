# Pi Code Mode sandbox

This package deploys Pi Code Mode's QuickJS runtime in a dedicated Cloudflare Worker. It is an
execution boundary only: it has no public route, credentials, application storage, or network tools.
The control plane connects to its Durable Object through a retained cross-Worker binding.

Validate the bundle locally with:

```bash
npm run build -w @open-inspect/pi-codemode-sandbox
```

Wrangler is the sole production owner of this Worker, its versions, QuickJS WASM, and the
`CodemodeSandbox` migration. Use the manual **Deploy Pi Code Mode Sandbox** workflow, which calls
`scripts/deploy-pi-codemode-sandbox.sh` with a deterministic deployment-scoped name. Terraform must
never create or adopt this Worker; it only adds the external binding after live verification.
