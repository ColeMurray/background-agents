# Pi execution isolation canary evidence

Copy this file per provider/runtime artifact. Do not record credentials, command output, environment
values, or transcript content. This is an evidence template only; scripts do not create sandboxes or
deploy infrastructure.

## Artifact

- Git commit:
- Runtime version (generation 78+):
- Execution artifact SHA-256 from `attest-execution-isolation.mjs`:
- Provider and immutable image/template/checkpoint ID:
- Clean artifact verification passed (no agent/desktop/terminal binaries):

## Provider controls

- Provider: Modal / Modal VM / OpenComputer / Daytona / Vercel / E2B
- Verdict: `passed` / `canary_blocked`
- Sandbox-layer domain allowlist observed:
- Exact allowed domains (control plane, npm, PyPI only):
- Arbitrary/Git/GitHub/apt/crates egress denied:
- Clean base artifact used; repository images and session snapshots refused:
- Platform limitation/blocker:

## Attack matrix

- `/proc/*/environ` cannot read supervisor/bridge environment:
- `ps` and `/proc/*/cmdline` reveal no credential:
- Runtime/supervisor files and credential caches are inaccessible:
- Execution token rejected by every HTTP credential/diff/push route:
- User/repository/model/MCP secrets and image/setup hooks are absent:
- Command UID/GID is 10001/10001 with no supplementary groups:
- Workspace is the only writable tree and is mode 0700:
- Runtime install is root-owned and non-writable:
- Bridge heartbeats, preservation, and command events work over the execution WebSocket:

## Current repository verdict

Until every attack above passes on a disposable live sandbox, keep that provider's evidence status
`canary_blocked`. The checked-in Slice 6A evidence expects all providers to remain blocked. Run the
read-only verifier with
`EXECUTION_ISOLATION_EVIDENCE=<path> node scripts/attest-execution-isolation.mjs`.
