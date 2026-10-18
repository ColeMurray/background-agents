# Pi repository editing report

## Outcome

Pi can now edit a bounded, durable VFS copy of repositories attached to its session when the
independent `PI_REPOSITORY_EDITING_MODE=enabled` capability is selected. Both capability gates
default to `off`; `PI_WORKSPACE_MODE=read_only` remains limited to its four scratch-space tools.

SessionDO is still the authority. It resolves strict full Git SHAs, claims those pins through the
existing `SessionDiffService`, reads provider trees/blobs under explicit limits, and returns a
credential-free manifest plus batches of at most 40 files. PiSessionDO stages each repository at
`/workspace/repos/{position}` before one rename, stores its manifest and original text overlays
outside `/workspace`, keeps `/workspace/scratch` separate and read-only, and never constructs
Computer Git or an execution/network backend.

The writable tool surface is deliberately small: Computer's generic `write`, `edit`, and `delete`
tools admitted through the shared `local_mutation` classification and a bounded UTF-8 repository
guard. The canonical composite policy supplies callers and unsafe replay metadata. One FIFO remains
held from guard preparation through actual Computer execution, reconciliation, canonical bundle
assembly, and SessionDO publication, so a later mutation cannot publish behind an older result.
Browser retries route to PiSessionDO for Pi sessions and keep the existing sandbox command path for
other harnesses.

## Limits

- 1,000 regular files across the writable session; each provider tree is capped at 1,000 entries.
- 256 KiB per file and 2 MiB total materialized bytes per repository.
- Existing SessionDiff limits remain authoritative for changed files and patch bytes.
- Symlinks, submodules, unsupported Git modes, truncated trees, provider size mismatches, binary
  mutation, recursive deletion, shell, Git, network, mounts, and publishing fail closed.

## Verification

- Control-plane full suite: 4,902 passed, 1 skipped.
- Shared full suite: 1,293 passed. Web full suite: 2,525 passed.
- Focused Pi/diff/MCP/external-action workerd suite: 78 passed.
- Docs tests: 44 passed; the webpack production build also passed.
- Terraform production suite: 80 passed. Terraform workflow contracts: 31 passed.
