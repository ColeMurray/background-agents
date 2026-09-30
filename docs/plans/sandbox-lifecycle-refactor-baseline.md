# Sandbox lifecycle refactor: T1 verification baseline

This is the verification companion to
[COL-240](https://linear.app/colemurray/issue/COL-240/refactor-sandboxlifecyclemanager-into-focused-collaborators)
and [ADR 0004](../adr/0004-sandbox-checkpoint-and-shutdown.md), not a replacement design. The
proposed `sandbox-lifecycle-manager-refactor.md` was not present in this checkout. No production
extraction or protocol change is part of T1.

## Checkout and owners

- Starting HEAD: `4e5c1f3bce26974890a822c894651688ae6e4045` (clean `main`, tracking `origin/main`);
  research baseline: `eef911f36e704fc49104546a9cd52b584d8b9223`. Five subsequent commits change
  session visibility/indexing, Modal VM Docker-preparation failure handling, VM lookup for partially
  published tunnels, and client/provider response handling. `vm-resolve.test.ts` gains a
  Docker-unavailable regression. None extracts lifecycle responsibilities. Do not replace these
  changes with the research snapshot.
- COL-238 (heartbeat confirmation) and COL-161 (spawn-time context injection) were **In Progress**
  in Linear at inspection, not landed in this HEAD. Current watchdog/bridge and launch-context
  behavior is the tested baseline, not the proposals in those issues. Recheck at each subsequent
  task; preserve any changes that land.
- `sandbox/lifecycle/manager.ts` still owns reservation, launch choice, provider claims, recovery,
  failure/breaker accounting, public admission/readiness, access preparation, VM resolution state,
  rejected cleanup, alarm dispatch/effects, and termination flags. `decisions.ts` and
  `alarm-policy.ts` own pure policy; `ports.ts` exposes consumer boundaries; `test-helpers.ts`
  assembles manager fixtures.
- `session/sandbox-repository.ts` owns conditional SQL and encrypted access;
  `session/sandbox-shutdown.ts` plus `sandbox-shutdown-repository.ts` own durable holds, receipts,
  source retirement and recovery. `session/components.ts` wires both. `connection-authenticator.ts`
  authenticates/attaches sockets; `sandbox-events/runtime.handler.ts` reports runtime facts;
  `alarm/handler.ts` orders shutdown before lifecycle watchdogs and `alarm/scheduler.ts` persists
  shared deadlines. Queue/push use the public lifecycle policy, not direct shutdown decisions.

The manager's admission/termination flags are `isSpawningSandbox`, `isTerminatingSandbox`, and
`providerStartupPending`; VM reconciliation owns `bridgeResolution`, `bridgeRetryGeneration`,
`bridgeStartupClaim`, `bridgeResolvedStartup`, and `vmStartupAuth` today, all in that same class.
`spawnSandbox` selects startup mode, `reserveSpawnIdentity` commits the launch identity,
`claimProviderStartup` admits the provider result, `resolveUnknownVmStartup` and
`resolvePendingBridge` reconcile VM responses, `attemptRejectedStartupCleanup` retries rejected
handles, and `handleAlarm` dispatches watchdog effects. `retireShutdownAccess` is still manager
wiring from the shutdown coordinator. These are **current** owners, not extracted contracts.

## Compatibility evidence

Paths in this table are relative to `packages/control-plane/`: `L/` means `src/sandbox/lifecycle/`,
`S/` means `src/session/`, `I/` means `test/integration/`. **P**: passed in the pre-edit focused
commands below; **N**: named existing test not selected by those commands (not a pre-edit pass
claim; related session suites were run after edits as recorded below). T1 additions were run
separately. Gaps are remaining evidence limits, not permission to change behavior during extraction.

| #   | Parent invariant                                                                                         | Named test evidence (pre-edit result)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Remaining gap / limit                                                                                        |
| --- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 1   | One manager public policy boundary; coordinator durable owner                                            | `L/manager.test.ts` "does not invoke collaborators during construction and honors the injected hold first" (P); `S/sandbox-shutdown.test.ts` "distinguishes unmanaged and held shutdown requests" (N)                                                                                                                                                                                                                                                                                                                                                                                             | Ownership also requires a code-boundary review; tests cannot prove no second authority was introduced.       |
| 2   | ID + timestamp generation and post-await conditional writes                                              | `S/sandbox-repository.test.ts` "refuses a ready that belongs to a generation the row no longer holds" (P); `L/manager.test.ts` "does not let a late completion touch a newer reservation that re-entered spawning" (P)                                                                                                                                                                                                                                                                                                                                                                            | Fresh/restore per-artifact writes are not generation-conditional (see separate gap below).                   |
| 3   | Atomic reservation/shutdown, immediate credential revocation, conditional hash                           | `I/sandbox-shutdown.test.ts` "rolls back the sandbox reservation when the matching shutdown write fails" (P); `L/manager.test.ts` "fresh spawn: reserves the new identity before hashing opens the input gate", "snapshot restore: reserves the new identity before hashing opens the input gate", "abandons the attempt without failure writes when the reservation is superseded" (P); `S/sandbox-repository.test.ts` "publishes the hash scoped to the reserved identity" (P)                                                                                                                  | Old authentication racing a _second_ reservation during the hash wait lacks one assembled real-storage test. |
| 4   | Provider response, bridge, ready and acknowledgement distinct                                            | `L/manager.test.ts` "leaves a sandbox that connected during the provider call ready when the call then fails" (P); `I/sandbox-shutdown.test.ts` "accepts early ready for a saved restore but gates the queue until provider lifetime settles", "holds queued work until a versioned runtime acknowledges its sandbox generation" (P)                                                                                                                                                                                                                                                              | Not every bridge/foreground finalization permutation is covered.                                             |
| 5   | Queue startup versus live-push readiness                                                                 | `I/sandbox-early-connect.test.ts` "holds a queued prompt while the bridge is attached but the sandbox is still booting, then dispatches on ready" (P); `S/message-queue.test.ts` "defers, without spawning, while the bridge is attached but the sandbox is still booting" (N); `S/sandbox-push-service.test.ts` "refuses, rather than fakes, a push while the attached sandbox is still booting" (N)                                                                                                                                                                                             | No single race tests both consumers across each gate transition.                                             |
| 6   | Unknown create/capture never proves absence or authorizes replay                                         | `L/vm-resolve.test.ts` "fails once when the allocation remains invisible past the bound, allowing respawn", "fails definitively for another generation", "bounds repeated transient lookup errors without failing the pending generation" (P), "retains the foreground token for an equal-valued bridge claim after inconclusive lookup" (**T1**); `S/sandbox-shutdown.test.ts` "holds a lost VM capture response without retiring the source" (N); `I/sandbox-state-retention.test.ts` "holds an ambiguous legacy snapshot restore across restart instead of invoking it again" (P)              | Null foreground resolution is not an absence assertion; foreground/bridge handoff is not exhaustive.         |
| 7   | Hold neither adopts nor destroys retained source; explicit continuation                                  | `L/manager.test.ts` "does not run generic termination or replacement while shutdown owns the source" (P); `I/sandbox-state-retention.test.ts` "preserve-stops a persistent provider instead of destroying its only recovery copy" (P); `S/sandbox-shutdown.test.ts` "keeps the hold when the source cannot be stopped for a discard" (N)                                                                                                                                                                                                                                                          | Late startup acceptance under an acquired hold has narrower race coverage.                                   |
| 8   | Fresh/restore/resume identity and prebuilt fallback differ                                               | `L/manager.test.ts` "refreshes terminal URL after resume without replacing its token", "does not silently create a fresh sandbox after retained final resume fails", "marks the repo image restore-failed and retries from base when its artifact is unavailable" (P); `L/vm-resolve.test.ts` "resolves an ambiguous base-image retry after a prebuilt image is unavailable" (P)                                                                                                                                                                                                                  | Retry versus outstanding old bridge/finalizer and token rotation not combined in one test.                   |
| 9   | Resume/bridge encrypt then conditional commit; only bridge checks reference; fresh/restore writes differ | `S/sandbox-repository.test.ts` "resolves a VM only while its generation and pending handle still match", "atomically records access for the current ... generation", "rejects access encrypted across a ... row", "ordinary resume does not require an expected bridge reference after encryption" (first two P; latter two **T1**); `L/vm-resolve.test.ts` "does not attach bridge access to a newer generation" (P)                                                                                                                                                                             | Fresh/restore's separate unscoped artifact writes can leak into a successor (separate bug; no safety claim). |
| 10  | Rejection fences/retains, rearm precedes I/O, matching cleanup                                           | `L/rejected-allocation.test.ts` "fences an early connected generation before waiting for mismatch cleanup", "retains rejected cleanup responsibility across restart and failed retirement", "rearms ... cleanup through the assembled alarm handler even under a shutdown hold" (P); "rearms cleanup before stop and does not clear a ... after the old stop succeeds" (**T1**); `S/sandbox-repository.test.ts` "fences ... and persists cleanup responsibility" (P)                                                                                                                              | Prior-generation replacement retirement has a different unscoped handle clear (separate bug).                |
| 11  | Failure writer, classification, breaker dispatch reset                                                   | `L/manager.test.ts` "counts an attempt once when the watchdog fails it before the provider rejects it", "handles provider errors and increments failure count for permanent errors", "does not increment circuit breaker for transient errors", "clears the boot-failure streak once a prompt is dispatched to the sandbox" (P); `S/message-queue.test.ts` "does not report a dispatch when the sandbox send fails" (N)                                                                                                                                                                           | No assembled queue retry during the watchdog/provider double-failure race.                                   |
| 12  | Alarm priority, pinned targets, effect ordering/guards/results                                           | `L/alarm-policy.test.ts` "prioritizes terminal, connect watchdog, stale heartbeat, boot budget, then inactivity"; `L/alarm-effects.test.ts` "heartbeat/inactivity publishes retirement before awaiting snapshot, then uses its required stop/shutdown order", "connecting watchdog/boot budget stops the generation it observed, not a replacement installed mid-alarm" (P); `L/alarm-boot-budget-effects.test.ts` "holds the termination guard only for provider stop, after publishing and detaching" (**T1**)                                                                                  | Guard coverage describes current order only; do not generalize it to other watchdogs.                        |
| 13  | Lazy logging, background timing, event/deadline/units and failure boundaries                             | `L/manager.test.ts` "does not invoke collaborators during construction and honors the injected hold first", "derives session_id from getSessionId per use, upgrading once the id changes" (P); `L/pending-vm-respawn.test.ts` "tracks a create/restore's pending handle with ...-second timeout after ... ms setup" (P); `S/alarm/scheduler.test.ts` "retains persisted state when setting the runtime alarm fails" (N)                                                                                                                                                                           | No exhaustive assertion of every log text or all three modes' best-effort/fatal boundaries.                  |
| 14  | Transient plaintext auth; expiry/restart cannot reconstruct token                                        | `S/sandbox-repository.test.ts` "sets all spawn fields atomically and invalidates credentials", "stores encrypted credentials and clears them" (P); `L/vm-resolve.test.ts` "reconciles a restarted bridge without blocking readiness or writing a replaced generation", "mints terminal access when the bridge resolves while the original instance holds the token" (P), "retains the foreground token for an equal-valued bridge claim after inconclusive lookup" (**T1**); `L/manager.test.ts` "keeps a resumed sandbox without terminal access when its terminal token is missing/expired" (P) | Old finalizer/new auth overlap still lacks a controlled interleaving; no exhaustive plaintext log assertion. |
| 15  | Conservative lifetime provenance is scheduling, not retirement proof                                     | `L/pending-vm-respawn.test.ts` "tracks a create/restore's pending handle with ...-second timeout after ... ms setup" (P); `S/sandbox-shutdown-safety.test.ts` "verifies provider stop for conservative expiry/legacy expiry without provenance before restoring saved state", "accepts authoritative provider expiry as retirement proof" (N); `L/manager.test.ts` "retires an ambiguously resumed retained object before explicitly retrying it" (P)                                                                                                                                             | No assembled restart interleaving spanning conservative bound, lost recovery response and source retirement. |

## Separate behavior gaps

These are _not_ extraction acceptance or claims of fixes. Confirm them with separate
reproducers/issues before behavior changes:

- Fresh and restore access use `updateSandboxAccess` / `updateSandboxTunnelUrls` without generation
  guards after encryption/other awaits; a replacement can receive the old artifact. The T1 real-SQL
  tests intentionally characterize only the stronger resume/bridge path. T3 adds the real-SQL
  reproducer "characterizes the unguarded fresh/restore artifact write across replacement":
  encryption yields, a new identity is reserved, then the old URL and encrypted secret land on the
  new row. The access extraction deliberately retains this behavior; a generation-guard fix is
  separate work.
- `connection-authenticator.ts` rechecks identity/credentials after `scheduleDisconnectCheck`, but
  not status; a same-generation stop during attachment can pass the final check. COL-238 proposes
  addressing this but is not landed here.
- `manager.ts` prior-generation `stopPriorProviderSandbox` clears the singleton provider handle
  after an await without comparing the replacement's generation/handle. This is distinct from the
  rejected-allocation cleanup characterized above.
- Foreground VM auth finalization uses generation **object identity** whereas bridge resolution uses
  equal-valued fields. T1 covers an inconclusive foreground lookup handing its token to an
  equal-valued bridge observation; an old-finalizer/new-auth overlap still lacks coverage. Treat a
  new safety assertion failing on this checkout as a separate bug, not a refactor regression.
- T3 characterizes another existing error boundary: "holds saved resume when its terminal secret
  read fails before startup is committed". A successful provider response followed by secret-read
  failure still marks the attempt failed and holds saved recovery. This differs from
  access-write/publication failures after committed recovery, which retain startup success. No
  boundary was moved or fixed.

## Commands and results

Node `v24.20.0` satisfies root `engines.node >=24.0.0`; dependencies were installed. Commands ran
sequentially from repository root before test edits:

| Command                                                                                                                                                      | Pre-edit result                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `npm run build -w @open-inspect/shared`                                                                                                                      | Passed (`tsc`).                                                                           |
| `npm test -w @open-inspect/control-plane -- src/sandbox/lifecycle src/session/sandbox-access src/session/sandbox-repository`                                 | Passed: 18 files, 600 tests.                                                              |
| `npm run test:integration -w @open-inspect/control-plane -- sandbox-early-connect session-lifecycle-alarm-recovery sandbox-shutdown sandbox-state-retention` | Passed: 4 files, 55 tests (Workerd provider substitutes, not live provider verification). |
| `npm run typecheck -w @open-inspect/control-plane`                                                                                                           | Passed all four TypeScript configs.                                                       |
| `npm run test:lint-sandbox-boundaries`                                                                                                                       | Passed: 2 tests.                                                                          |
| `git diff --check`                                                                                                                                           | Passed; checkout was clean.                                                               |

After T1 test edits, the targeted 3-file command
`npm test -w @open-inspect/control-plane -- src/session/sandbox-repository.test.ts src/sandbox/lifecycle/rejected-allocation.test.ts src/sandbox/lifecycle/alarm-boot-budget-effects.test.ts`
passed: 98 tests. Its first run failed only because the new guard observation expected two
broadcasts when the existing path emits three; the assertion was corrected to record the actual
baseline sequence.
`npm test -w @open-inspect/control-plane -- src/sandbox/lifecycle/vm-resolve.test.ts` then passed:
21 tests. No production code was changed. Post-edit focused unit tests passed (18 files, 608 tests),
Workerd integration passed (4 files, 55 tests), and control-plane typecheck, boundary lint (2
tests), targeted Prettier and ESLint checks, and `git diff --check` passed. Shared was built before
dependent checks as recorded above. No full control-plane unit/integration sweep, bundle build, or
live-provider canary was run for T1; those remain later-story verification.

Additional post-edit command:
`npm test -w @open-inspect/control-plane -- src/session/sandbox-shutdown.test.ts src/session/sandbox-shutdown-safety.test.ts src/session/message-queue.test.ts src/session/sandbox-push-service.test.ts src/session/connection-authenticator.test.ts src/session/alarm src/session/sandbox-events/runtime.handler.test.ts`
passed (8 files, 278 tests). This includes the session-side N entries above; N still records their
pre-edit baseline scope honestly. It is not a full unit-suite run.
