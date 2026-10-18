# Pi sandbox execution foundation: ledger

Workspace: repository root on `feat/pi-sandbox-exec`

Base: `4dcaed00` (`feat/pi-first-class` stack)

Started: 2026-10-18

Rule: tick only with evidence on the same line.

## Contract and persistence

- [x] Shared provider-neutral runtime mode, command, and event schemas — shared suite 1,291/1,291
- [x] SessionDO command ledger and reserved migrations 58/59, including bridge identity, replacement
      indeterminacy, and bounded output — control-plane suite 4,880/4,880
- [x] Focused schema/repository tests pass — included in unit and 89 integration tests
- [x] Committed — `3c9ee77b` establishes the durable command contracts; `26069d21` adopts the
      reserved recovery contracts

## Runtime and providers

- [x] Execution-only mode reaches every provider without changing the default agent launch — shared
      env builder plus Modal adapter; provider tests green
- [x] Python runtime boots repository and execution bridge without parsing an agent harness — full
      runtime suite 1,660 passed, 36 skipped
- [x] Process-group runner supports streaming, bounded replay/gap reporting, timeout, cancellation
      races, replacement containment, and a non-secret child env — focused and full runtime suites
- [x] Focused TypeScript and Python tests pass — control plane 4,880; runtime 1,660; Modal 562
- [x] Committed — `00a55049`

## Dormant SessionDO integration

- [x] Pi execution feature flag fails closed — `.env.example`, workflow, Terraform, Worker binding,
      canonical capability mode and 6 Terraform tests
- [x] Sandbox is provisioned lazily and command dispatch waits for versioned execution readiness —
      coordinator and runtime-floor tests
- [x] Runtime events settle the durable ledger; same-bridge reconnect replays while bridge/provider
      replacement becomes indeterminate — repository, restart, and integration tests
- [x] No Pi extension or model-visible tool exposes execution — PiSessionDO exact tool-list
      integration test remains green
- [x] Focused integration tests pass — PiSessionDO/events/state-retention/shutdown 89/89
- [x] Committed — `00a55049`; reconnect/readiness corrections in `0aad511d`

## Finish

- [x] Shared package built before dependents — shared build and control-plane typecheck green
- [x] Typecheck, lint, formatting, control-plane tests, and sandbox-runtime tests pass — affected
      TypeScript/Python checks green; pre-existing unrelated Modal/Codex mypy findings remain
- [x] Existing harness behavior remains covered and green — full control-plane, sandbox-runtime,
      Modal, shared, and docs suites
- [x] Provider canary blockers documented — `features/pi-sandbox-exec/CANARY.md`
- [x] Branch is unpushed and worktree state verified — rebased onto `feat/pi-first-class` at
      `4dcaed00`; `git branch -vv` shows no upstream; 6 commits above the stack and 22 above
      `origin/main`
