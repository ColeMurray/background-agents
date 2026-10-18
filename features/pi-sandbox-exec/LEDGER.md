# Pi sandbox execution foundation: ledger

Workspace: repository root on `feat/pi-sandbox-exec`

Base: `d7a401ca` (`feat/pi-first-class` stack)

Started: 2026-10-18

Rule: tick only with evidence on the same line.

## Contract and persistence

- [x] Shared provider-neutral runtime mode, command, and event schemas — shared suite 1,301/1,301
- [x] SessionDO command ledger and reserved migrations 58/59, including bridge identity, replacement
      indeterminacy, and bounded output — control-plane suite 4,948/4,948
- [x] Focused schema/repository tests pass — included in unit and 95 integration tests
- [x] Committed — `12aa3e86` establishes the durable command contracts; `e0a63165` adopts the
      reserved recovery contracts

## Runtime and providers

- [x] Execution-only mode reaches every provider without changing the default agent launch — shared
      env builder plus Modal adapter; provider tests green
- [x] Python runtime boots repository and execution bridge without parsing an agent harness — full
      runtime suite 1,660 passed, 36 skipped
- [x] Process-group runner supports streaming, bounded replay/gap reporting, timeout, cancellation
      races, replacement containment, and a non-secret child env — focused and full runtime suites
- [x] Focused TypeScript and Python tests pass — control plane 4,948; runtime 1,660; Modal 562
- [x] Committed — `da492e8f`

## Dormant SessionDO integration

- [x] Pi execution feature flag fails closed — `.env.example`, workflow, Terraform, Worker binding,
      canonical capability mode and 7 Terraform tests
- [x] Sandbox is provisioned lazily and command dispatch waits for versioned execution readiness —
      coordinator and runtime-floor tests
- [x] Runtime events settle the durable ledger; same-bridge reconnect replays while bridge/provider
      replacement becomes indeterminate — repository, restart, and integration tests
- [x] No Pi extension or model-visible tool exposes execution — PiSessionDO exact tool-list
      integration test remains green
- [x] Focused integration tests pass — PiSessionDO/external-actions/events/state-retention/shutdown
      95/95 with writable workspace and external actions enabled together
- [x] Committed — `da492e8f`; reconnect/readiness corrections in `f816b2f1`; combined
      alarm/router/migration coverage in `aa7f3537`

## Finish

- [x] Shared package built before dependents — shared build and control-plane typecheck green
- [x] Typecheck, lint, formatting, control-plane tests, and sandbox-runtime tests pass — affected
      TypeScript/Python checks green; pre-existing unrelated Modal/Codex mypy findings remain
- [x] Existing harness behavior remains covered and green — full control-plane, sandbox-runtime,
      Modal and shared suites; writable workspace policy/quota/redaction plus external action and
      MCP routes/flags/migrations retained
- [x] Provider canary blockers documented — `features/pi-sandbox-exec/CANARY.md`
- [x] Branch is unpushed and worktree state verified — rebased onto `feat/pi-first-class` at
      `d7a401ca`; `git branch -vv` shows no upstream; 8 commits above the stack and 33 above
      `origin/main`
