# First-class Pi Durable coding agent: specification map

## Product definition

A first-class Open-Inspect Pi session keeps its durable agent state in `PiSessionDO`, gains an
immediate durable workspace and native Pi Durable Code Mode, and reaches credentials or external
effects only through SessionDO-authorized tools. A traditional VM/container sandbox is optional and
created lazily for work that needs native processes.

Pi Durable is the durable head, not a replacement for execution environments. Its tools may run in
the same process, a lightweight in-memory/SQLite workspace, or a remote machine. Open-Inspect uses
all three levels deliberately:

1. Cloudflare Computer VFS in `PiSessionDO` for durable, credential-free working files.
2. A separate QuickJS Worker for Pi Durable Code Mode orchestration.
3. Existing Open-Inspect sandbox providers as remote hands for shells, package installation,
   compilers, browsers, and native processes.

Computer's official Pi-AI tools are adapted directly into Pi Durable registrations; Open-Inspect
does not reimplement Pi's large `ExecutionEnv` interface over Computer. A later remote execution
adapter may implement that interface for existing full sandboxes.

## Terms

| Term                 | Meaning in this project                                                                |
| -------------------- | -------------------------------------------------------------------------------------- |
| Pi coding-agent SDK  | Node/Bun application SDK (`@earendil-works/pi-coding-agent`); not embedded             |
| Pi Durable           | Durable conversation/task/tool/compaction runtime used as the agent engine             |
| Cloudflare PiHarness | Agents SDK lifecycle/storage adapter that hosts Pi Durable in a DO                     |
| Computer Workspace   | Durable VFS and optional isolated Worker-JS backend supplied as tools                  |
| Code Mode sandbox    | Separate QuickJS DO; Pi Durable owns its journal and nested calls                      |
| Traditional sandbox  | E2B/Modal/Daytona/Vercel/OpenComputer Linux-like environment, explicit escalation only |

## Requirement map

| Requirement                           | Current status       | Implementation                                                                     |
| ------------------------------------- | -------------------- | ---------------------------------------------------------------------------------- |
| Atomic sessions/tasks/recovery        | Exists               | Pi Durable + PiHarness in base PR                                                  |
| Automatic compaction                  | Exists               | Pi default policy in base PR                                                       |
| Extensions and managed skills         | Exists               | `packages/control-plane/src/pi/`                                                   |
| Foreground subagents                  | Exists, UI partial   | Stream child conversation in Slice 5                                               |
| Commit-pinned repository reads        | Exists               | SessionDO-authorized provider `readFile`/`listTree`                                |
| Durable writable files                | Done                 | Quota proxy over Computer VFS; no exec/Git/network                                 |
| Write/edit/delete tools               | Done for scratch VFS | Unsafe replay, sequential mode, global FIFO, redacted events                       |
| JavaScript execution                  | Build later          | Worker-JS only after Terraform supports `worker_loader`                            |
| Durable Code Mode                     | Build                | External QuickJS Worker + native Pi extension                                      |
| Mutation approval/audit               | Partial              | Local scratch policy hooks/memos done; external approval later                     |
| Deferred tools/tool search            | Build                | Native Pi Durable extension after catalog expands                                  |
| Pi steering/follow-ups                | Partial              | Admit directly to Pi with durable operation projection                             |
| Reset/handoff/forks/manual compaction | Missing UI/API       | Extend Pi runtime port in Slice 5                                                  |
| Task graph/inspect                    | Missing              | Sanitized runtime projection in Slice 5                                            |
| Reasoning/retry/inbox/failure events  | Partial              | Extend event translation in Slice 5                                                |
| MCP static headers                    | Blocked              | Encrypted broker, never direct Pi client                                           |
| MCP OAuth                             | Blocked              | Per-principal D1 authority and callback UI                                         |
| MCP mutation replay                   | Blocked              | Execution ledger and indeterminate outcomes                                        |
| Automation executor MCP               | Blocked              | Executor-owned grants and firing-time reauthorization                              |
| Browser                               | Later                | Agents Browser capability after core policy gates                                  |
| Memory tools                          | Shipped              | The existing D1 memory authority, reached through the session's own internal route |
| Attachments/images                    | Later                | Bounded attachment adapter and model capability checks                             |
| Native shell/builds                   | Explicit escalation  | Linked sandbox child; never silently mutate Pi backend                             |
| GitHub/Linear Pi flows                | Blocked              | Require diff/mutation/publication tools first                                      |

## Delivery slices

### 1. Code Mode sandbox infrastructure

- New isolated Worker package exporting only `CodemodeSandboxDurableObject`.
- Extend the Terraform Worker module for additional WASM modules and optional external DO bindings.
- No public route, credentials, storage authority, or control-plane behavior.
- Blast radius: Terraform Worker module and build workflow; protect every existing Worker
  deployment.

### 2. Read-only durable VFS workspace

- Follow Cloudflare's Pi example with one workspace per `PiSessionDO` unless conformance/performance
  proves a separate workspace DO is necessary.
- Wrap Computer Pi-AI results into Pi Durable 1.3 `output` results.
- Initially expose only `read`, `ls`, `find`, and `grep` under `/workspace/scratch`.
- Exclude mutations, exec, assets, mounts, runtime access, and Computer Git.
- Construct the Workspace only after session identity/deletion checks, so a cold request cannot
  recreate VFS tables for a deleted session.
- Blast radius: Pi DO SQLite, deletion, bundle size, memory; add schema-prefix and restart tests.

### 3. Permission and audit policy

- Install a mandatory extension containing `beforeTool` and `afterTool` hooks.
- SessionDO authorizes external effects; Pi documents only durable approval state.
- Bounded `write`, `edit`, and forced `delete` are available only for credential-free scratch VFS
  after durable aggregate quota accounting. All are unsafe-replay, globally serialized, and deny
  deletion of the `/workspace/scratch` root and its `/workspace` container. Scratch quota remains
  separate from repository overlay roots and their mutation gate. External effects still require
  SessionDO authorization and approval policy before exposure.
- Blast radius: authorization, timeline events, replay; default-deny unknown mutations.

### 4. Native durable Code Mode

- `RemoteCodemodeSandbox` + `createCodemodeExtension()`.
- Model sees Code Mode; scripts call repository/workspace tools as nested calls.
- Blast radius: external Worker availability, replay fingerprints, nested events, abort/deletion.

### 5. Pi-native product surfaces

- Direct steer/follow-up admission, reset/handoff/forks/manual compact.
- Child conversation streams and task graph/inspect UI.
- Blast radius: SessionDO's single-processing-message assumption, callbacks, usage attribution.

### 6. MCP broker

- Agents SDK 0.28.1 now provides plain-DO `Lifecycle` installation plus persisted HTTP transport
  restoration. The dependency blocker is resolved; Open-Inspect still needs its identity-first
  lifecycle composition, callback route, reviewed-catalog verification, and live canary.
- Encrypted D1 authority, stable revisions/tool names, SSRF guard, per-principal connection DO.
- Read-only interactive canary before OAuth/mutations/automations.

### 7. OAuth, approvals, and automations

- OAuth callback and personal connection UI.
- Durable approval/elicitation/execution state.
- Executor-owned unattended grants invalidated on reassignment.

### 8. Optional integrations

- Browser, memory, images, and explicit sandbox escalation only after preceding gates pass.

## Global invariants

1. Pi Durable is the only agent-loop and transcript authority.
2. SessionDO is the only Open-Inspect authorization, approval, callback, and audit authority.
3. D1 is the only long-lived credential authority.
4. No credential enters Pi, workspace, Code Mode, event, export, prompt, or tool-result storage.
5. Every external effect has an explicit replay/idempotency/indeterminate contract.
6. Existing sessions remain operable when new Pi admission is disabled.
7. Every optional capability fails closed and can be disabled independently.
