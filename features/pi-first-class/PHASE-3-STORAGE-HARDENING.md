# Integration Phase 3: storage hardening

## Outcome

Pi's Computer workspace now receives an explicit filesystem-only facade rather than a pass-through
`Workspace` proxy. The facade exposes only the methods required by Computer's pinned 0.5.1 Pi tools;
runtime, provider, Git, assets, artifacts, mounts, rename, symlink, and chmod remain unreachable.
Scratch accounting is versioned and fenced to the durable VFS revision. Root directories are checked
with `lstat`, deep writes reserve parents and file bytes together, and failed or interrupted writes
reconcile without consuming quota.

Workspace arguments are bounded by UTF-8 path bytes, depth, edit structure, query size, glob count,
and pagination before Computer or durable policy memos process them. Grep remains literal by
default; regex mode is disabled. A queued abort never dispatches. An abort received after dispatch
reports the mutation as indeterminate-or-applied after durable reconciliation instead of claiming
rollback.

Repository overlays now use a canonical version-2 manifest with SHA-256 content hashes. Cold restore
validates roots, paths, modes, sizes, hashes, baselines, changed-path metadata, additions,
deletions, and unexplained files. Session-wide live-byte, file, total-entry, hidden-metadata, depth,
and path limits cover initial materialization and later mutations under the canonical FIFO. Provider
blob reads use a bounded, credential-free immutable promise cache after fresh scope resolution and
emit admission/request metrics. Existing version-1 manifests migrate atomically from durable current
files and baselines without provider access or loss of edits, additions, and deletions.

Successful repository mutations stage a bounded diff bundle and arm a keyed Lifecycle job before
external publication. One serialized outbox authority prevents older publishes from overtaking newer
state. Upload and capture failures retain the last successful bundle, record a durable error, and
preserve recapture generations through eviction. The assembler deterministically omits files and
updates `truncated`/`omittedFileCount` until the exact wire envelope is valid.

Terraform keeps both capabilities off by default and hard-fails any workspace or repository-editing
activation unless `pi_computer_preview_acknowledged = true` explicitly accepts Computer 0.5.1's
preview status. Public docs define prospective revocation and pinned-data retention semantics.

## Validation

- Control-plane unit: 309 files, 5,101 passed, 1 skipped.
- Control-plane workerd: 172 files, 2,462 passed, 1 skipped; final focused Pi rerun: 50 passed.
- Shared: 1,303 passed. The full web run passed 2,532/2,533 before one unchanged timeout; that file
  passed 65/65 in isolation, and the focused diff suite passed 27/27.
- Docs: 44 passed and 185 static pages built.
- Terraform production: 93 passed. Terraform workflow contracts: 32 passed.
- Root build, typecheck, ESLint, Prettier, SQL portability, complexity report, Terraform validate,
  Terraform format, and diff checks passed.

No deployment or push was performed. The remaining activation gate is a live deployment-owner canary
for the exact preview dependency and provider installation limits.
