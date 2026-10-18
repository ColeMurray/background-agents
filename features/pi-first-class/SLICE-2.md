# Slice 2 report: read-only durable Computer VFS workspace

## Outcome

Added an optional, credential-free Cloudflare Computer workspace to `PiSessionDO`. It lives in the
same Durable Object SQLite database as Pi and Lifecycle, but uses Computer's distinct VFS tables.
The workspace is constructed only after session identity, deletion, and SessionDO context checks
succeed.

The model receives exactly four tools under `/workspace`:

- `read`
- `ls`
- `find`
- `grep`

There is no mutation, exec backend, Git client, network capability, mount, asset publisher, or raw
Workspace access. An explicit allowlist prevents a future Computer release from silently widening
the tool set.

## Compatibility seam

Computer 0.5.1 returns Pi-AI-style `{ content, isError, details }`. Pi Durable 1.3 expects
`{ output, isError, details }`. The adapter explicitly maps `content` to `output`, preserves
constrained sampling, and accepts details only after JSON validation.

## Rollout

- `PI_WORKSPACE_MODE=off` is the deployment default.
- `read_only` enables the four tools.
- Unknown values, including the future `writable` value, fail closed to `off` in runtime; Terraform
  rejects them.
- Cloudflare labels Computer 0.5.1 preview-only and not production-ready. Documentation therefore
  limits enablement to personal/staging canaries unless the deployment owner explicitly accepts the
  preview risk.

## Security and lifecycle

- Tool paths are confined to `/workspace`; lexical and symlink escapes fail.
- Two Pi sessions with the same path retain distinct contents.
- Missing SessionDO context creates no VFS schema.
- Warm and cold deletion remove Pi and Computer state together through `deleteAll()`.
- `Workspace.close()` runs after Pi stops and before storage deletion.
- Repository tools remain the authority for immutable pinned source; scratch files cannot masquerade
  as repository state.

## Bundle contract

The Worker build includes only Computer core and its Pi tool adapter. Tests exclude Computer Git,
all execution backends, modules/git, and `just-bash`; the Node host bundle contains no Computer
code. The Worker bundle increased by approximately 471 KB raw / 100 KB gzip.

## Evidence

- Focused adapter/mode/build tests: 16 passed.
- PiSessionDO workerd tests: 13 passed.
- Production Terraform tests: 79 passed.
- Docs tests: 44 passed.
- Repository typecheck, ESLint, Prettier, Terraform fmt/validate, workflow contracts, README
  translations, and clean `npm ci` passed.
