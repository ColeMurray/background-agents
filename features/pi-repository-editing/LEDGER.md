# Pi repository editing: ledger

Workspace: repository root on `feat/pi-repository-editing`

Base: `03343fc6` (`feat/pi-first-class`, canonical capabilities/effects/assembler prerequisite)

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
- [x] Committed — `debbba59` (`feat: add Pi repository editing overlay`, rebased)

## Slice 2: VFS overlay and diff publication

- [x] RED tests: staging/restart, guarded mutation, diff capture, retry routing — failures observed
      before each implementation
- [x] GREEN implementation — position roots, raw-byte UTF-8 guard, shared `local_mutation` Computer
      tools, global net-change accounting
- [x] Integration and regression tests green — 17 PiSessionDO workerd tests; real `0xff`, 51-file
      batches, branch-move crash recovery, SessionDiff publication/retry
- [x] Security/deep audit and simplify pass — watchdog P1-P3 and cross-cutting blockers reconciled;
      no Computer Git/network/credentials and unknown tools fail closed
- [x] Committed — `efe030a7` (`fix: harden Pi repository editing boundaries`, rebased)

## Finish

- [x] Documentation states rollout flag and limitations — `SLICE.md`, `SPEC-MAP.md`, and
      `docs/GETTING_STARTED.md`
- [x] Git branch and rebased commits verified — `feat/pi-repository-editing` is based on `03343fc6`;
      canonical-adoption follow-up commit follows
- [x] No push performed — local worktree only
