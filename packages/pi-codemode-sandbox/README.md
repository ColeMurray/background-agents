# Pi Code Mode sandbox

This package deploys Pi Code Mode's QuickJS runtime in a dedicated Cloudflare Worker. It is an
execution boundary only: it has no public route, credentials, application storage, or network tools.
The control plane will connect to its Durable Object through a cross-Worker binding in a later
integration slice.

Build the Terraform upload artifacts with:

```bash
npm run build -w @open-inspect/pi-codemode-sandbox
```

Wrangler compiles the imported QuickJS WASM module. The post-build step gives that module a stable
`dist/quickjs.wasm` name so Terraform can upload the JavaScript, source map, and WASM modules
together. Production deployment remains Terraform-owned; do not run `wrangler deploy` without
`--dry-run`.
