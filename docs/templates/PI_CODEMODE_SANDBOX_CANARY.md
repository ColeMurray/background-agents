# Pi Code Mode sandbox deployment evidence

Copy this file for each deployment/canary. Do not record credentials.

## Identity

- Date/time (UTC):
- Operator:
- Git commit:
- Deployment name:
- Worker name (`open-inspect-pi-codemode-sandbox-<deployment>`):
- Cloudflare account identifier (non-secret label only):
- Wrangler version:
- Operation: fresh deploy / upgrade / rollback

## Deployment proof

- Wrangler command run via `Deploy Pi Code Mode Sandbox` workflow:
- Deployed Worker version ID:
- Previous Worker version ID (upgrade/rollback):
- `CodemodeSandbox` v1 SQLite migration visible:
- `quickjs.wasm` module visible:
- Worker self-bindings: **none**
- Routes: **none**
- workers.dev: **disabled**
- Preview URLs: **disabled**
- Variables/secrets/service bindings: **none**
- Effective CPU limit: **60000 ms**

## Runtime canary

- External `CODEMODE_SANDBOX` binding deployed only after the Worker proof above:
- Bounded script result:
- Nested authorized read result:
- Abort result:
- Effective CPU-limit behavior verified:

## Rollback

- Runtime admission changed to `off` first:
- External binding retained for latched-session replay:
- Wrangler rollback target version ID:
- Previously admitted replay completed after rollback:
- New Code Mode call denied after rollback:

## Approval

- `PI_CODEMODE_SANDBOX_DEPLOYMENT_VERIFIED=true` approved by:
- `PI_CODEMODE_PAID_CANARY_VERIFIED=true` approved by:
- Notes / incident links:
