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
guard. They are unsafe-replay Pi tools. Each mutation reconciles the session-global net overlay and
publishes it through the existing SessionDiff store. Browser retries route to PiSessionDO for Pi
sessions and keep the existing sandbox command path for other harnesses.

## Limits

- 1,000 regular files across the writable session; each provider tree is capped at 1,000 entries.
- 256 KiB per file and 2 MiB total materialized bytes per repository.
- Existing SessionDiff limits remain authoritative for changed files and patch bytes.
- Symlinks, submodules, unsupported Git modes, truncated trees, provider size mismatches, binary
  mutation, recursive deletion, shell, Git, network, mounts, and publishing fail closed.

## Verification

- Focused control-plane tests: 243 passed, including the Worker bundle contract.
- Shared package tests: 1,268 passed.
- PiSessionDO workerd integration tests: 17 passed, including real invalid UTF-8 bytes, 51-file
  batching, baseline crash recovery after a branch move, mutation, SessionDiff publication, and
  retry routing without a sandbox.
- Docs tests: 44 passed. Terraform workspace-mode tests: 4 passed.
