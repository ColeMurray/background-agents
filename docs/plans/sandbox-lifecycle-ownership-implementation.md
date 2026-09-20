# Sandbox lifecycle ownership: C1 implementation

## Status and scope

Implemented the behavior-preserving C1 increment from Design C on branch
`sandbox-lifecycle-ownership`, based on `222f1c002f1ba9ff7624090e1424b7e556b772f6`. Implementation
and verification used an isolated worktree, preserving the existing public checkout, design
artifacts, and production checkout. This report records pre-publication validation; no deployment
was performed.

**C1 is implemented; C2 is not.** This follows the design's phase-3 gate: stop before
preservation-dependent changes when that protocol is absent. No snapshot status was removed and no
preservation guarantees were introduced.

## Ownership changes

| Responsibility                  | Owner after C1                              | Callers retain                                             |
| ------------------------------- | ------------------------------------------- | ---------------------------------------------------------- |
| Ordinary command eligibility    | Pure lifecycle decisions                    | Queue claims, push correlation, transport delivery         |
| Interactive access eligibility  | Pure lifecycle decisions                    | Credential decryption and post-await field revalidation    |
| Authoritative socket lookup     | WebSocket manager                           | Socket identity, recovery, and terminal socket cleanup     |
| Accept runtime readiness        | Existing lifecycle manager + repository CAS | Event persistence, queue wake, inactivity scheduling       |
| Sandbox cancellation transition | Existing lifecycle manager                  | HTTP session authorization/status and message cancellation |

`getSandboxCommandTarget()` replaces reconstruction from a ready getter followed by an attached
getter. It returns `dispatch` with a socket, `booting`, or `unavailable`. It is an ephemeral
classification, **not a lease across awaits**. Lifecycle control commands continue to use the
attached socket path.

The runtime event handler and HTTP lifecycle handler have narrow dependencies without raw lifecycle
writes. The access reader receives read-only repository ports. No new coordinator, generic state
machine, or manager-above-manager was introduced. Existing fatal/alarm/launch/retirement transitions
already reside in the lifecycle manager. Aggregate creation of the initial pending row remains an
initialization responsibility, not a second transition-policy owner.

## Compatibility contract

| Situation                            | Preserved behavior                                                          |
| ------------------------------------ | --------------------------------------------------------------------------- |
| Ready + authoritative socket         | Ordinary commands can dispatch; access is available                         |
| Snapshotting + authoritative socket  | Ordinary commands can dispatch; access remains unavailable                  |
| Attached booting bridge              | Queue defers; push reports the existing starting error                      |
| No usable bridge                     | Existing acquisition path; push retains the manual-push assumption          |
| Failed/stopped/stale row             | Ordinary dispatch unavailable; lingering sockets are cleaned up             |
| Failed reconnect                     | Existing separate admission policy, not conflated with dispatch             |
| Session cancellation                 | Cancel queued/running work first, then sandbox shutdown, then stopped write |
| Stale row on cancellation            | Becomes stopped; failed/stopped rows stay unchanged                         |
| Local shutdown send returns false    | Still writes stopped, as before                                             |
| Late ready after cancellation        | Event can be recorded; readiness CAS cannot revive stopped compute          |
| Credentials change during decryption | Access response rejects rather than returning stale credentials             |

Readiness keeps its exact effect order: event processing and persistence, guarded readiness commit,
activity timestamp, ready publication, queue wake, then best-effort inactivity scheduling.
Duplicate/rejected readiness does not repeat the wake or publication. Admission generation/token
snapshots and persisted socket authority checks are unchanged.

Persisted status values, wire messages, schema, provider contracts, runtime code, timeouts, retry
constants, snapshot save/restore behavior, and recovery selection are unchanged. `warming` remains a
presentation-only union member; the policy matrix covers it without introducing a persisted state.

Two implementation-level differences are intentional: readiness logging now uses the lifecycle
manager's logger, and queue/push make one socket lookup instead of two, avoiding redundant attempts
to close an already-dead lingering socket.

## Verification

Run commands from this worktree's repository root. Shared was built before dependent validation. The
pre-change focused baseline passed 529 tests.

| Check                                                                             | Result                                                                |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `npm run test -w @open-inspect/control-plane -- --silent`                         | 303 files, 4,796 tests passed                                         |
| Full Workerd integration suite, before final added scenario                       | 109 files, 1,306 passed, 1 skipped                                    |
| `npm run test:integration -w @open-inspect/control-plane -- --silent`             | 109 files, 1,307 passed, 1 skipped                                    |
| Added cancellation → late-ready Workerd scenario and existing early-connect suite | 7 tests passed                                                        |
| `npm run typecheck -w @open-inspect/control-plane`                                | Passed Worker, Node, unit-test, integration-test configurations       |
| `npm run build -w @open-inspect/control-plane`                                    | Worker and Node bundles passed                                        |
| ESLint on all changed/new TypeScript; Prettier; `git diff --check`                | Passed                                                                |
| Independent architecture reviews                                                  | No blocking command/access or readiness/cancellation regression found |

New or strengthened checks include:

- An explicit compatibility matrix for every status union member; separate
  access/reconnect/cancellation decisions. Transport tests cover missing and terminal sockets.
- Lifecycle-owned cancellation ordering, excluded states, missing transport, unsuccessful send, and
  absence of unintended provider stop/fence/detach effects.
- Readiness CAS/activity/publication ordering and rejected/missing-row cases.
- Runtime-handler tests exercise orchestration through a focused readiness port, including rejected
  readiness and fallible inactivity scheduling. Manager/storage tests cover readiness guards and
  effect ordering; Workerd tests cover the assembled wiring.
- Access tests use real encryption and asynchronous decryption, and replace
  status/identity/provider/access fields across that await.
- Workerd exercises actual HTTP cancellation and an authenticated bridge's late ready event. The
  test waits for event broadcast rather than using a sleep as proof of processing. It checks stopped
  sandbox, cancelled session, and the existing failed-message cancellation reason.
- Explicit read/runtime/socket/initialization ports restrict consumers' repository capabilities.
  ESLint enforces imports through ports instead of concrete repository/manager implementations;
  `npm run test:lint-sandbox-boundaries` verifies the real ESLint configuration. No custom AST
  scanner or single-owner-file allowlist remains.

Full suites cover existing admission races, hibernation/socket recovery, boot budget, alarm
behavior, queue claims, snapshot histories, provider adapters, and Node conformance. Automated
passing tests are evidence, not proof that every production interleaving is regression-free. No live
provider-backed canary or production traffic validation was performed. Workerd uses test provider
responses.

## Explicitly not fixed in C1

The design separates policy relocation from correctness changes. This increment does not claim a new
final-revalidation/dispatch lease, monotonic attempt identity, durable exactly-once launch, stop
acknowledgement, or shutdown-before-retirement safety guarantee. It does not repair the known
status-only attach-time gap. Those require separate changes and adversarial tests, not silent
semantics added to this refactor.

## C2 dependency and next increment

The baseline lacks the durable preservation record, runtime preparation handshake, confirmed stop
protocol, provider capture semantics, admission hold, and recovery receipts required by C2. A nearby
implementation exists on `final-sandbox-preservation` at inspected head `ef7a92d21`, but importing
it would add 92 changed files against this baseline, spanning runtime, providers, control plane, and
web behavior. It was not silently merged into C1.

A split preservation stack was also inspected: runtime `6493b6e51`, control plane `7023301a1`, and
settings/web `78c2c1d69`, based on `417151ff0`. These are inspected local snapshots, not claims of
deployment or approval. Revalidate exact heads before choosing an integration base.

Preservation itself is not yet C2: it still writes/restores `snapshotting`, returns void from
checkpoint capture, and lacks per-checkpoint operation identity.

After selecting/integrating the preservation base:

1. Reconcile C1 with the single existing preservation owner and rerun both suites.
2. Add explicit checkpoint outcomes and operation-scoped publication; do not add another capture
   journal or parallel preservation coordinator.
3. Remove snapshot status overloading with explicit access/dispatch/idle rules, including restart,
   duplicate, cancellation, and late-completion histories.
4. Implement safe legacy snapshot handling and an operation-aware rollback path.
5. Validate runtime/image compatibility and provider-backed canaries before enabling behavior
   changes. An expired timer is not proof capture ended.

## C1 rollout and rollback

This increment requires no schema or wire migration. Deploy through the normal review/release
process, observe readiness latency, queue deferrals, push-starting errors, access 409s, cancellation
outcomes, and existing recovery alarms. Compare against the baseline rather than assuming changed
ownership improves outcomes. C1 can be rolled back to its baseline without new persisted data to
reconcile. This rollback statement does **not** apply to later C2 operation records/holds.

## Simplification Analysis

### Core Purpose

Centralize existing sandbox policy and transition ownership without changing behavior.

### Unnecessary Complexity Found

- `createSessionRuntime`: an obsolete lifecycle socket adapter remained after cancellation moved to
  the manager. Removed it; the manager's adapter remains.
- `SessionLifecycleHandler` test harness: obsolete raw status and transport mocks remained after the
  dependency changed. Removed them.
- Event processor test harness: removed two obsolete readiness repository mocks.

### Code to Remove

- Findings removed: ten lines total. No further removal required.

### Simplification Recommendations

1. Keep named decisions and narrow existing ports; no new framework is needed.
2. Keep C2's operation ownership with preservation instead of adding a duplicate owner.

### YAGNI Violations

No remaining speculative framework identified. Do not add generic operation records or new status
enums to this behavior-preserving increment.

### Final Assessment

Total cleanup: ten lines removed. Added abstraction complexity: low; existing lifecycle subsystem
complexity remains. Recommended action: review C1 independently; resolve the preservation
integration base before C2.
