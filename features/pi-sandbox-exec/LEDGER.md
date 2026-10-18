# Pi sandbox execution foundation: ledger

Workspace: repository root on `feat/pi-sandbox-exec`

Base: `9fbdecf0` (`feat/pi-first-class` stack)

Started: 2026-10-18

Rule: tick only with evidence on the same line.

## Contract and persistence

- [x] Shared provider-neutral runtime mode, command, and event schemas — 19 shared contract tests
- [x] SessionDO command ledger and migration, including idempotent transitions and bounded output —
      migration 58 + `SandboxCommandRepository`
- [x] Focused schema/repository tests pass — 54 control-plane tests
- [ ] Committed

## Runtime and providers

- [ ] Execution-only mode reaches every provider without changing the default agent launch
- [ ] Python runtime boots repository + execution bridge without an agent harness
- [ ] Process-group runner supports streaming, replay, timeout, and cancellation
- [ ] Focused TypeScript and Python tests pass
- [ ] Committed

## Dormant SessionDO integration

- [ ] Pi execution feature flag fails closed
- [ ] Sandbox is provisioned lazily and command dispatch waits for readiness
- [ ] Runtime events settle the durable ledger and reconnect replays pending work
- [ ] No Pi extension or model-visible tool exposes execution
- [ ] Focused integration tests pass
- [ ] Committed

## Finish

- [ ] Shared package built before dependents
- [ ] Typecheck, lint, formatting, control-plane tests, and sandbox-runtime tests pass
- [ ] Existing harness behavior remains covered and green
- [ ] Provider canary blockers documented
- [ ] Branch is unpushed and worktree state verified
