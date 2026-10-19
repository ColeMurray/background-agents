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
- Artifact SHA-256 (`artifact-manifest.json`):
- `index.js` SHA-256 / bytes:
- `quickjs.wasm` SHA-256 / bytes:

## Deployment proof

- Wrangler command run via `Deploy Pi Code Mode Sandbox` workflow:
- Deployed Worker version ID:
- Active deployment is exactly this version at **100%**:
- Observed Cloudflare script etag:
- Deployment message contains the exact artifact SHA-256:
- Previous Worker version ID (upgrade/rollback):
- `CodemodeSandbox` v1 SQLite migration visible:
- `quickjs.wasm` module visible:
- Worker self-bindings: **none**
- Routes: **none**
- workers.dev: **disabled**
- Preview URLs: **disabled**
- Variables/secrets/service bindings: **none**
- Routes/custom domains/scheduled triggers: **none** (all managed zone IDs checked)
- Effective CPU limit: **60000 ms**

## Runtime canary

- External `CODEMODE_SANDBOX` binding deployed only after the Worker proof above:
- Canonical SessionDO session/message operation IDs:
- Canonical timeline event IDs (top-level Code Mode, nested read, abort):
- Bounded script result: **passed**
- Nested authorized read result: **passed**
- Abort result: **passed**
- Direct Pi/public transcript access used: **no**
- Effective CPU-limit behavior verified:
- Read-only `attest-pi-codemode-sandbox.mjs` output path:

The runtime evidence JSON consumed by the attestation script has this bounded shape. Obtain the IDs
from the authorized SessionDO session/timeline; never call PiSessionDO directly.

```json
{
  "sessionId": "session-id",
  "operationId": "canonical-message-id",
  "boundedScript": "passed",
  "nestedAuthorizedRead": "passed",
  "abort": "passed",
  "directPiAccess": false,
  "timelineEventIds": ["codemode-event", "nested-read-event", "abort-event"]
}
```

Run the read-only live observation with `PI_CODEMODE_ARTIFACT_MANIFEST`,
`PI_CODEMODE_RUNTIME_EVIDENCE`, `PI_CODEMODE_WORKER_NAME`, `PI_CODEMODE_EXPECTED_VERSION`,
`PI_CODEMODE_ZONE_IDS` (every managed zone, comma-separated), `CLOUDFLARE_ACCOUNT_ID`, and a
read-scoped `CLOUDFLARE_API_TOKEN`. Optionally set `PI_CODEMODE_ATTESTATION_OUTPUT` to a new path;
the script refuses to overwrite existing evidence.

## Rollback

- Runtime admission changed to `off` first:
- External binding retained for latched-session replay:
- Wrangler rollback target version ID:
- Previously admitted replay completed after rollback:
- New Code Mode call denied after rollback:

## Approval

- `PI_CODEMODE_SANDBOX_DEPLOYMENT_VERIFIED=true` approved by:
- `PI_CODEMODE_SANDBOX_DEPLOYED_VERSION` (must equal line 19):
- `PI_CODEMODE_PAID_CANARY_VERIFIED=true` approved by:
- `PI_CODEMODE_PAID_CANARY_VERSION` (must equal deployed version):
- Notes / incident links:
