# First-class Pi Durable coding agent: ledger

Spec folder: `features/pi-first-class/`

Workspace: repository root @ `feat/pi-first-class`

Base: `d1ffd951` (`feat/pi-durable-harness`)

Started: 2026-10-18

Rule: tick only with evidence on the same line.

## Phase 1: Understand

- [x] Intentional stacked worktree created from the audited Pi foundation — `git status -sb`; base
      `d1ffd951`
- [x] Source set read — Pi Durable Technical Manual 1.0.3; Pi Durable 1.3
      README/changelog/source/examples; Pi coding-agent SDK docs; Cloudflare Agents
      PiHarness/extensions/example; Pi Codemode Cloudflare example; Agents MCP docs/source;
      Open-Inspect AGENTS/docs/current Pi PR
- [x] Existing code mapped — `docs/plans/pi-durable-harness.md`, `packages/control-plane/src/pi/`,
      `pi-durable-object.ts`, SessionDO internal handlers, Terraform Worker module
- [x] Terms translated — `SPEC-MAP.md` distinguishes Pi coding agent, Pi Durable, Cloudflare
      PiHarness, Computer workspace, Code Mode sandbox, and traditional sandbox
- [x] `SPEC-MAP.md`: requirements classified — `features/pi-first-class/SPEC-MAP.md`
- [x] Product decisions answered — use PiHarness + Pi Durable; no nested coding-agent SDK; no inline
      QuickJS; D1 remains credential authority; traditional sandbox only by explicit escalation

## Phase 2: Plan

- [x] Slices, blast radius, tests, and pitfalls documented — `SPEC-MAP.md#delivery-slices`
- [x] Simplicity pass — VFS before exec; no Computer Git; no direct MCP in PiSessionDO; no
      browser/attachments until core gates pass
- [x] Adversarial review — independent Code Mode, MCP/OAuth, manual coverage, security,
      product-surface, and efficiency audits incorporated
- [x] User approved the direction — `/goal` on 2026-10-18

## Phase 3: Slices

### Slice 1: isolated Code Mode sandbox infrastructure

- [x] Tests pinning existing behavior — RED: missing package/Worker/Terraform contracts failed
      before implementation; module defaults preserve existing workers.dev and nullable preview
      behavior
- [x] Terraform/module contracts — 6 module tests + 1 production-root test; migration-only class,
      external DO, WASM, privacy, retained bindings, traversal rejection
- [x] Sandbox Worker implemented — `packages/pi-codemode-sandbox/`; Wrangler dry bundle contains
      `index.js`, `index.js.map`, and `quickjs.wasm`
- [x] Unit/build/deployment-contract tests — sandbox contract 1/1; workflow contracts 28/28;
      production Terraform 76/76
- [x] Deep audit — independent Pi API, Terraform, repository integration, threat-model, Cloudflare,
      security, CI, migration, and final provider reviews; all concrete findings resolved
- [x] `/simplify` — removed unused self-binding, separate runner, test-only outputs, premature hard
      CPU requirement, and brittle Terraform regex checks
- [x] Narrow validation green — build/typecheck/lint/format, 6 module tests, 76 production tests,
      README translations, clean `npm ci`
- [x] Committed — `ea447fda` (`feat: add isolated Pi Code Mode sandbox`)
- [x] Slice report — `features/pi-first-class/SLICE-1.md`
- [x] Ownership correction — unsupported Terraform Worker/version ownership removed; dedicated
      Wrangler fresh/upgrade/rollback workflow is sole owner, Terraform retains only verified
      binding

### Slice 2: read-only durable Computer VFS workspace

- [x] Tests pinning existing behavior — RED proved missing adapter/tool exposure before
      implementation
- [x] Workspace/tool contract — exact-pinned Computer 0.5.1, Pi Durable 1.3 output adapter, explicit
      four-tool allowlist
- [x] Read/ls/find/grep implemented without mutation/exec/Git/network — `open-inspect.workspace`,
      now rooted at `/workspace/scratch` so future repository overlays remain outside scratch quota
- [x] Unit + workerd tests — 16 focused unit/build checks, 13 PiSessionDO integration checks, 3
      Terraform mode checks
- [x] Deep audit — independent API/runtime/security/build/dependency reviewers; writable-mode
      deletion, prompt, symlink, isolation, env, and bundle findings resolved
- [x] `/simplify` — one lazy Workspace per PiSessionDO, no extra DO, no ExecutionEnv
      reimplementation, no backend imports
- [x] Narrow validation green — full typecheck/lint/format; production Terraform 79/79; docs 44/44;
      clean npm ci
- [x] Committed — `0c001d02` (`feat: add read-only Pi workspace`)
- [x] Slice report — `features/pi-first-class/SLICE-2.md`

### Slice 3: permission and audit extension

- [x] Existing mutation behavior pinned — RED for writable mode, tool registration, quota proxy,
      root deletion, FIFO, event redaction, workerd tool flow, and Terraform mode
- [x] Approval/document/audit contract — bounded local scratch mutations auto-allow through
      metadata-only durable task memos; external effects remain unexposed
- [x] `beforeTool`/`afterTool` policy implemented — shared effect metadata separates local reads,
      local mutations, and external effects; unclassified Computer mutations fail closed
- [x] Role/denial/replay tests — SessionDO still owns session authorization; unknown mutation/root/
      quota denials and unsafe replay metadata are covered
- [x] Durable mutation contract — 8 MiB/1,000-entry aggregate accounting with dirty-state recovery,
      unsafe replay, sequential rounds, and one global FIFO
- [x] Deep audit — two local trace/security/recovery rounds plus architecture and watchdog reviews;
      undefined edit details, policy ownership, entry exhaustion, missing-file workerd behavior,
      eviction recovery, durable capability snapshots, nested redaction, scratch/overlay separation,
      and contradictory docs resolved
- [x] `/simplify` — one quota filesystem proxy, one workspace-wide FIFO, canonical shared effects
      and extension slot, and one composite policy; no duplicate effect contract or external-action
      gateway
- [x] Narrow and full relevant validation green — 4,896 control-plane unit tests, 15 PiSessionDO
      workerd tests, 4 workspace Terraform tests, 44 docs tests, docs build, root typecheck, lint,
      format, Terraform validate/fmt, and Worker bundle boundary
- [x] Committed — `97bcfee7`, `8df485a7`, `040980eb`
- [x] Slice report — `features/pi-first-class/SLICE-3-WRITABLE-WORKSPACE.md`

### Slice 4: Pi Durable Code Mode integration

- [x] Existing tool exposure pinned — focused extension and PiSessionDO workerd assertions
- [x] Remote sandbox/runtime contract — portable `RemoteCodemodeSandbox`; external DO binding only
- [x] Native `createCodemodeExtension()` integration — canonical capability snapshot, `code_mode`
      slot/effects, composite policy delegate, durable emergency-admission memo
- [ ] Nested event projection remains part of Slice 5; replay, abort, fingerprint, and close are
      covered here by native SQLite replay tests and the compiled two-Worker restart lane
- [x] Deep audit — architecture and sandbox watchdog corrections incorporated; live provider proof
      remains an explicit canary blocker
- [x] `/simplify` — canonical capability snapshot, assembler slot/effects, and composite policy only
- [x] Narrow validation green — unit, native durable replay, two-Worker workerd, Terraform, build,
      typecheck, lint, format, docs
- [ ] Committed
- [x] Slice report — `features/pi-first-class/SLICE-4.md`

### Slice 5: Pi-native inbox, conversation, and event fidelity

- [ ] Existing queue behavior pinned
- [ ] Runtime/API contracts
- [ ] steer/follow-up/reset/handoff/fork/compact/task graph implemented
- [ ] Event/subagent/recovery tests
- [ ] Deep audit
- [ ] `/simplify`
- [ ] Narrow validation green
- [ ] Committed
- [ ] Slice report

### Slice 6: encrypted MCP connection broker

- [ ] Existing MCP behavior pinned
- [ ] D1/DO/RBAC/stable-identity contracts
- [ ] Static-header broker + SSRF controls implemented
- [ ] Encryption/isolation/catalog tests
- [ ] Deep audit
- [ ] `/simplify`
- [ ] Narrow validation green
- [ ] Committed
- [ ] Slice report

### Slice 7: MCP OAuth, approvals, elicitation, and executor grants

- [ ] Existing provider/automation authority pinned
- [ ] OAuth/interaction/execution-ledger contracts
- [ ] OAuth UI and broker flows implemented
- [ ] Owner/executor/replay/indeterminate tests
- [ ] Deep audit
- [ ] `/simplify`
- [ ] Narrow validation green
- [ ] Committed
- [ ] Slice report

### Slice 8: optional integrations and explicit escalation

- [ ] Browser/memory/attachment/escalation scope tests
- [ ] Contracts
- [ ] Authorized capabilities implemented
- [ ] E2E/security tests
- [ ] Deep audit
- [ ] `/simplify`
- [ ] Narrow validation green
- [ ] Committed
- [ ] Slice report

## Phase 4: Whole-feature audit

- [ ] Per-commit trace vs spec/manual/examples
- [ ] Parallel reviewer round 1 reconciled
- [ ] Round 2+ finds no real issues
- [ ] Every real bug has cause and regression guard

## Phase 5: End to end

- [ ] `JOURNEYS.md` written
- [ ] Browser journeys completed
- [ ] Durable state checked after key actions
- [ ] Accessibility pass
- [ ] E2E tests added
- [ ] Bugs fixed and smoke tests rerun
- [ ] Cleanup complete

## Phase 6: Finish

- [ ] Docs, invariants, and runbooks updated
- [ ] 10-minute user test checklist written
- [ ] Rebased on current upstream after foundation merge
- [ ] Git state verified
- [ ] Final report given

## Done / skipped on purpose / left

| Requirement                   | Status             | Evidence or reason                                              |
| ----------------------------- | ------------------ | --------------------------------------------------------------- |
| Pi durable runtime foundation | Done in base       | PR #2431, base `d1ffd951`                                       |
| Writable workspace            | Done               | Slice 3; implementation, policy, audit, and validation complete |
| Durable Code Mode             | Left               | Slices 1 and 4                                                  |
| MCP/OAuth                     | Left               | Slices 6 and 7; requires guarded restore support in Agents SDK  |
| Native Linux builds           | Skipped by default | Explicit linked sandbox escalation only                         |
