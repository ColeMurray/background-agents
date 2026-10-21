# Pi repository editing: ledger

Workspace: repository root on `feat/pi-repository-editing`

Base: `3605e0fd` (`feat/pi-first-class`, canonical sandbox execution and Code Mode tip)

Started: 2026-10-18

Rule: tick only with evidence on the same line.

## Understand and plan

- [x] Existing repository reads, Computer VFS, Pi bridge, provider tree APIs, and SessionDiff
      service traced — `SPEC-MAP.md`
- [x] Security boundary fixed — SessionDO owns credentials/baselines/diff publication; Pi receives
      credential-free bounded bytes only
- [x] Simplicity pass — no Computer Git, no network backend, no full Git implementation, no binary
      mutation

## Slice 1: contracts and authority

- [x] RED tests: strict pins, Git modes, exact bounded materialization, baseline claim — failures
      observed in provider, repository-tools, bridge, and SessionDiff suites
- [x] GREEN implementation — full SHA-1/SHA-256 IDs, exact modes, 40-file batches, crash-safe
      SessionDO baseline reuse
- [x] Focused tests and typecheck green — focused control-plane merge-gate suites; shared and all
      four control-plane TypeScript projects clean
- [x] Committed — `8390b65e` (`feat: add Pi repository editing overlay`, rebased)

## Slice 2: VFS overlay and diff publication

- [x] RED tests: staging/restart, guarded mutation, diff capture, retry routing — failures observed
      before each implementation
- [x] GREEN implementation — position roots, raw-byte UTF-8 guard, shared `local_mutation` Computer
      tools, global net-change accounting
- [x] Integration and regression tests green — PiSessionDO workerd coverage includes real `0xff`,
      51-file batches, branch-move crash recovery, SessionDiff publication/retry
- [x] Security/deep audit and simplify pass — watchdog P1-P3 and cross-cutting blockers reconciled;
      no Computer Git/network/credentials and unknown tools fail closed
- [x] Committed — `04289b20` (`fix: harden Pi repository editing boundaries`, rebased)

## Finish

- [x] Documentation states rollout flag and limitations — `SLICE.md`, `SPEC-MAP.md`, and
      `docs/GETTING_STARTED.md`
- [x] Sandbox-generation fixture drift resolved — diff readiness now uses the active sandbox ID;
      extension expectations follow the canonical assembler slot order
- [x] Combined verification green — control 4,990/1 skipped; shared 1,302; web 2,525; focused
      workerd 96; Code Mode workerd 9; Code Mode sandbox contracts 5; docs 44 plus webpack build;
      Terraform 97; workflow contracts 31+1; root typecheck, lint, format, and offline `npm ci`
- [x] Git branch and rebased commits verified — `feat/pi-repository-editing` is based on exact
      `3605e0fd`; all seven repository commits follow additively
- [x] No push performed — local worktree only
