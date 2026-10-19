# Pi Code Mode sandbox

This package deploys Pi Code Mode's QuickJS runtime in a dedicated Cloudflare Worker. It is an
execution boundary only: it has no public route, credentials, application storage, or network tools.
The control plane connects to its Durable Object through a retained cross-Worker binding.

Validate the bundle locally with:

```bash
npm run build -w @open-inspect/pi-codemode-sandbox
npm run verify:artifact -w @open-inspect/pi-codemode-sandbox
```

Wrangler is the sole production owner of this Worker, its versions, QuickJS WASM, and the
`CodemodeSandbox` migration. Use the manual **Deploy Pi Code Mode Sandbox** workflow, which calls
`scripts/deploy-pi-codemode-sandbox.sh` with a deterministic deployment-scoped name. Terraform must
never create or adopt this Worker; it only adds the external binding after live verification.

The build emits `dist/artifact-manifest.json` with exact `index.js` and `quickjs.wasm` SHA-256
hashes. The protected workflow preserves that artifact and deploys it once with rebundling disabled.
After an authorized SessionDO runtime canary, use `scripts/attest-pi-codemode-sandbox.mjs` to
compare the manifest and canonical timeline evidence with Cloudflare's observed version, deployment,
etag, runtime, migration, privacy, binding, route, domain, and secret state. The attestation script
is read-only and cannot deploy.
