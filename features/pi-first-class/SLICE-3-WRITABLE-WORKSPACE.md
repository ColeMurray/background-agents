# Slice 3 report: safe writable durable workspace

## Outcome

`PI_WORKSPACE_MODE=writable` extends Pi's credential-free `/workspace/scratch` area with `write`,
`edit`, and forced `delete`. Scratch quota and policy do not cover future repository overlays under
other `/workspace` roots. Read-only mode is otherwise unchanged. Writable mode still exposes no
execution backend, shell, Git, network, mounts, assets, publishing, or raw Workspace handle.

## Mutation safety

- Each mutation is `replay: "unsafe"` and `executionMode: "sequential"` in Pi Durable 1.3.
- One per-session FIFO serializes mutations across tool names and continues after failures.
- A filesystem proxy enforces an 8 MiB and 1,000-entry aggregate quota across files and directories,
  accounting for creates, overwrites, recursive deletion, and paginated recovery rather than only
  bounding each call.
- Quota state is persisted with a dirty marker before filesystem mutation. A dirty or malformed
  record is rebuilt by walking `/workspace/scratch` before the next mutation, covering eviction
  between the file change and accounting commit.
- Both the tool boundary and filesystem proxy reject deletion of `/workspace/scratch` and its
  `/workspace` container, including equivalent lexical spellings.
- Projected timeline events keep paths and structure but redact write content, edit
  search/replacement text, and write/edit output such as diffs.
- Mandatory `beforeTool`/`afterTool` hooks auto-allow only bounded local scratch mutations, keep
  metadata-only durable task memos, and deny unclassified Computer mutations. Shared tool-effect
  metadata labels workspace reads `local_read` and write/edit/delete `local_mutation`, leaving
  external-action authorization to its separate gateway.

## Rollout and rollback

The deployment default remains `off`. `read_only` remains available as the lower-risk canary mode.
Set `writable` only after accepting Cloudflare Computer 0.5.1's preview status. Each session durably
snapshots its capability on first open, so a later deployment change cannot silently upgrade or
downgrade it after eviction. Roll back first to `read_only` for later sessions, then optionally to
`off`. Normal rollback keeps the Pi Durable Object binding and storage so existing sessions can
continue and be deleted normally.

## Validation

- Control-plane unit: 282 files, 4,896 passed, 1 skipped.
- Writable workspace/policy/event focused unit: 70 passed; canonical shared contract focused unit: 8
  passed.
- PiSessionDO workerd integration: 15 passed, including missing-file creation and forced eviction
  dirty-state recovery.
- Workspace Terraform mode subset: 4 passed. The full production run passed 79 tests and its final
  unrelated case failed while the mocked Vercel provider fetched its framework catalog over the
  network and timed out.
- Docs: 44 passed and production build completed all 185 static pages.
- Repository typecheck, control-plane lint, Prettier, Terraform validate/fmt, and the Worker bundle
  boundary test passed. The bundle still excludes Computer backends, Git modules, and `just-bash`.

The repository-wide workerd suite was attempted twice but did not terminate within 10 minutes. Its
output reached unrelated session/team suites and the existing forced-eviction test before timeout;
the focused PiSessionDO integration file is clean. This remains an upstream/full-suite runtime
blocker, not a skipped writable-workspace assertion.

Computer 0.5.1 successfully creates a missing file but the Workers Vitest pool also reports the
tool's handled `ENOENT` intermediate rejection. The integration config suppresses only
`WorkspaceFsError` + `ENOENT` under `/workspace/` whose stack points to Computer's write tool; the
workerd test then verifies the write, edit, read, and delete results and persisted file bytes.

## 10-minute canary checklist

1. On a personal or staging deployment, set `PI_WORKSPACE_MODE=writable` and apply Terraform.
2. Start a Pi Durable session and ask:
   `Write hello world to /workspace/scratch/hello.txt, edit world to Pi, read it back, then delete the file.`
3. Confirm the answer reports `hello Pi`, the timeline shows the three mutation tools without file
   contents or an edit diff, and no sandbox or terminal controls appear.
4. Ask: `Recursively delete /workspace/scratch.` Confirm the tool fails and the session can still
   write and read `/workspace/scratch/kept.txt` afterward.
5. Set `PI_WORKSPACE_MODE=read_only` and apply Terraform. Confirm the existing session remains
   writable, then open a new Pi session and confirm it has reads while write, edit, and delete are
   absent.
6. Set the mode to `off` if the canary should end. Do not remove the `PI_SESSION` binding or delete
   Durable Object storage as part of rollback.
