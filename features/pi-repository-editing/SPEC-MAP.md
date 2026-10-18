# Pi repository editing: specification map

## Product boundary

Pi edits a credential-free Virtual File System (VFS) copy of each session repository. SessionDO
remains the only source-control and session-diff authority: it resolves immutable commits, reads
provider blobs, claims the diff baseline, and accepts bounded diff bundles. PiSessionDO receives
only file bytes plus non-secret Git metadata. Computer Git, process execution, network access, and
credentials remain unavailable.

## Requirements

| Requirement                         | Implementation                                                                                                                     | Gate     |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Immutable repository identity       | Accept only full 40- or 64-hex object IDs for durable pins and materialization                                                     | Required |
| Session diff baseline               | SessionDO atomically claims Pi's repository pins through `SessionDiffService` and rejects conflicts                                | Required |
| Exact provider tree metadata        | Preserve the provider's Git mode for every tree entry                                                                              | Required |
| Bounded materialization             | Refuse truncated trees, unsupported modes, unsafe/duplicate paths, excess files, excess per-file bytes, and excess aggregate bytes | Required |
| Credential isolation                | Transfer a JSON manifest plus 40-file batches containing only identity, paths, modes, blob IDs, and base64 file bytes              | Required |
| Durable staging                     | Build repositories in hidden VFS staging paths and rename only after every file succeeds; retain a hidden manifest                 | Required |
| Guarded mutation                    | Consume shared `local_mutation` classification and Computer `write`/`edit`/`delete` semantics under `/workspace/repos/{position}`  | Required |
| Diff capture                        | Capture net text changes and publish through the existing SessionDiff service/store                                                | Required |
| Retry                               | Route browser diff retries to PiSessionDO for Pi sessions and to the sandbox for other harnesses                                   | Required |
| No Computer Git/network/credentials | Do not construct Git clients, execution backends, mounts, or credential-bearing workspace state                                    | Required |

## Deliberately excluded

- Shells, package installation, builds, browser automation, Git commits, pushes, and pull requests.
- Symlink and submodule materialization. Exactness requires refusing these instead of silently
  dropping them.
- Binary mutation. Binary files may be materialized and read, but repository mutation is text-only.
- Directory deletion and rename detection. The first writable contract supports file-level net
  changes only.

## Delivery slices

1. Strict pin, provider metadata, materialization, and baseline-claim contracts.
2. Credential-free VFS staging, guarded mutation, diff publication, and retry routing.
