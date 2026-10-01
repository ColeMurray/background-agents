# Sandbox Lifecycle Refactor: Final Verification

This is COL-247's closure evidence for [COL-240](https://linear.app/colemurray/issue/COL-240). The
[ownership guide](sandbox-lifecycle-manager-refactor.md) and
[ADR 0004](../adr/0004-sandbox-checkpoint-and-shutdown.md) remain the architecture specification;
the [T1 report](sandbox-lifecycle-refactor-baseline.md) is historical baseline evidence.

## Revision and Integration

- Research baseline: `eef911f36e704fc49104546a9cd52b584d8b9223`.
- Audited starting HEAD: `b98a378bdbe2dba1237953da9162e8a85a7e926a`, initially clean.
- Tested checkout: that HEAD plus this PR's boundary rules, composition import comment, regression
  tests and documentation. No lifecycle/provider/repository runtime implementation changes in T7.
- Environment: Node `v24.20.0`, installed workspace dependencies, repository root as working
  directory.
- Validation status: all required checks passed locally, subject to the existing KV TTL skip and
  release/evidence limits below. T7 still requires review/merge. No deployment or live-provider
  checks.

Actual history and combined source were reviewed, not just the watchdog extraction diff:

| Increment    | Integrated Main Commit               | Evidence                                                                    |
| ------------ | ------------------------------------ | --------------------------------------------------------------------------- |
| T1 / COL-241 | `0ce9e9d` (#2144)                    | Characterization matrix and assembled/real-storage regressions              |
| T2 / COL-242 | `44ca1a9` (#2148), `0318fd9` (#2149) | Launch context, then class-based construction                               |
| T3 / COL-243 | `d3de8c0` (#2151)                    | Access mechanics and direct shutdown retirement wiring                      |
| T4 / COL-244 | `64aa395` (#2166)                    | Five VM fields and reconciliation moved together                            |
| T5 / COL-245 | `60930ce` (#2170)                    | Stateless cleanup and shared bounded-stop operation                         |
| T6 / COL-246 | `b98a378` (#2172)                    | Stateless watchdog effects; complete boot-budget operation stays in manager |
| T7 / COL-247 | This PR, review/merge pending        | Combined audit, boundary checks, wiring regressions and full validation     |

## State and Dependency Owners

Paths below are relative to `packages/control-plane/src/`.

| State or Responsibility                                                                                     | Sole Owner                                                                                             |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `isSpawningSandbox`, `isTerminatingSandbox`, `providerStartupPending`                                       | `sandbox/lifecycle/manager.ts`                                                                         |
| Lazy `logMemo`                                                                                              | Manager; collaborators receive a lazy logger operation                                                 |
| `bridgeResolution`, `bridgeRetryGeneration`, `bridgeStartupClaim`, `bridgeResolvedStartup`, `vmStartupAuth` | `vm-startup-reconciliation.ts`; foreground object identity remains distinct from bridge field equality |
| Launch inputs/settings/images                                                                               | Readonly `SandboxLaunchContext`; no lifecycle flags, provider operations or authorization              |
| Access signing/reuse/retirement/notification                                                                | `SandboxAccess`; no retained signing key, eligibility or lifecycle state                               |
| Rejected/late cleanup and local stop bound                                                                  | Stateless `allocation-cleanup.ts` and `provider-stop.ts`; no new durable record                        |
| Connect/heartbeat/snapshot/inactivity effects                                                               | Stateless `watchdog-effects.ts`; no flags, scheduler or full manager reference                         |
| Conditional SQL and encryption                                                                              | `session/sandbox-repository.ts`, including atomic post-encryption resume/bridge checks                 |
| Durable checkpoint/shutdown/holds/receipts/recovery                                                         | `SandboxShutdownCoordinator` and `sandbox-shutdown-repository.ts`                                      |
| Shared pending/in-flight deadlines                                                                          | `session/alarm/scheduler.ts`, not extracted collaborators                                              |

Manager retains startup selection/orchestration, synchronous identity reservation, generic provider
claims, rejection policy, breaker/error ownership, readiness and queue/push admission, public
recovery, cancellation/archive policy, prior-generation retirement, fatal/unresponsive termination,
alarm capture/dispatch and the entire boot-budget effect. Only explicit boot-budget provider stop
owns that path's termination-guard interval, after publication and detach. No universal mutex was
introduced.

Composition still constructs repository/socket/messenger leaves, access, shutdown, then manager.
Shutdown calls access retirement directly, not a manager forwarding callback. Constructors do not
invoke runtime work; deferred queue callbacks run after construction. VM's only reverse manager
operation is resolved startup acceptance. Watchdog callbacks expose named manager-owned operations,
not mutable context or flag setters. Repositories implement internal contracts structurally.

Consumer ports remain separate from internal contracts. Authenticator, runtime handlers, queue,
execution stop, push, HTTP lifecycle, access readers and alarm handling retain their existing public
ports. Cloudflare and Node compose the same application graph through platform ports. No extraction
introduced full-manager consumer access or a second lifecycle/durable shutdown authority.

## Compatibility and Traces

No T7 public API, SQL schema, stored/wire shape, runtime/backend protocol, timeout, retry, setting,
log-event/message or provider-stop argument changes. Manager constructor wiring and internal type
locations intentionally changed in earlier extractions; they are not external consumer APIs.
Consumer `ports.ts`, lifecycle adapters, production sandbox repository, pure decisions/alarm policy,
platform ports and both platform entry points are unchanged from the research baseline.

The combined audit preserves these trace boundaries:

- Reservation commits sandbox identity and shutdown ownership synchronously, announces after commit,
  invalidates credentials before hashing, and conditionally publishes the hash before launch reads.
- Fresh retains environment/image/MCP/Slack order; restore retains environment/Slack/MCP order and
  pending registration immediately before synchronous recovery-invoked recording/provider dispatch.
  Resume gains no unrelated launch inputs. Confirmed-unavailable prebuilt retry rotates
  identity/auth.
- Unknown VM outcomes remain lookup-only; nullable foreground outcomes authorize neither replay nor
  destruction. Foreground finalization retains generation object identity and deferred token
  handoff.
- Provider completion, attachment, runtime readiness, lifetime, generation acknowledgement, queue
  admission and live push remain distinct. A held-current result is neither adopted nor destroyed.
- Resume/bridge encrypt before atomic eligibility checks; only bridge supplies expected reference.
  Fresh/restore retain separate artifact writes. Terminal expiry/hash-only restart cannot renew
  JWTs.
- Rejection fences and retains cleanup before I/O. Shared retry is persisted before stop, matching
  completion clears only its handle, and rejected cleanup precedes shutdown holds/watchdogs.
- Watchdogs retain captured generation checks, path-specific snapshot/stop/send/fence ordering,
  return values and queue redrive. Breaker charging stays with the failure writer and resets only
  after successful prompt dispatch. Logger/background resolution remains lazy/synchronously started
  at the original entry points. Local abort/timeout does not establish remote cancellation.

Two explicit reviewed fixes in earlier extraction PRs are exceptions to a purely mechanical claim:
COL-244 suppresses access announcement when deferred acceptance is refused; COL-245 requires an
actually dispatched, successful stop before confirmation-dependent cleanup/replacement. They are
documented in the ownership guide, not attributed to T7 or claimed to close broader safety gaps.

## Executed Evidence

Existing named evidence is retained in the T1 matrix and ownership guide, including assembled
manager launch/VM/cleanup/watchdog tests, real SQL/encryption tests, Workerd
recovery/early-connect/shutdown tests, scheduler/handler tests and Node in-memory/file-backed
storage conformance.

T7 adds only missing wiring or explicit inherited-gap reproducers:

- `test/integration/sandbox-vm-reconciliation.test.ts`: production runtime reconstructed over an
  actual foreground pending reservation. Real encryption is gated after ciphertext creation;
  changing only expected reference or reservation timestamp rejects completion without row/shutdown
  mutation or publication. Success retains early readiness/conservative lifetime, decryptable access
  and no restarted terminal signing authority. Admission is tested separately from lookup
  completion.
- `test/integration/sandbox-state-retention.test.ts`: reconstructed rejected cleanup now runs
  through production scheduled delivery and both shutdown-priority passes. Retry exists during
  provider I/O; failure preserves handle/hold/receipt; success conditionally clears; duplicate
  delivery does not stop again; the in-flight deadline is acknowledged.
- `src/sandbox/lifecycle/alarm-effects.test.ts`: two controlled assembled characterization traces
  record inherited successor retirement/absent-handle retargeting and post-stop failure publication.
- `scripts/lint-sandbox-boundaries.test.mjs`: existing ESLint checks now include launch-context and
  startup-errors, extension-bearing imports and permitted internal uses; no bespoke scanner/rule
  weakening. Composition's launch-port import has an explicit, justified exemption.

Checks ran sequentially, with one Vitest worker to avoid starving the sandbox. Log redirection under
`/tmp/opencode/col247-*.log` does not alter the commands or selections below.

| Exact Command                                                                                  | Exit / Result                                                              |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `npm run build -w @open-inspect/shared`                                                        | 0; passed                                                                  |
| `npm test -w @open-inspect/control-plane -- --maxWorkers=1`                                    | 0; 359 files / 6,114 tests passed (126.13 s)                               |
| `npm run test:integration -w @open-inspect/control-plane -- --maxWorkers=1`                    | Terminal timeout at 600 s; no completion result, not a pass                |
| `npm run test:integration -w @open-inspect/control-plane -- --maxWorkers=1 --reporter=verbose` | 0; 137 files / 1,742 tests passed, 1 existing skip (final rerun 647.39 s)  |
| `npm run typecheck -w @open-inspect/control-plane`                                             | 0; Worker, Node, unit and integration configurations passed                |
| `npm run build -w @open-inspect/control-plane`                                                 | 0; Worker and Node bundles passed (4.8 MB / 6.6 MB; esbuild size warnings) |
| `npm run lint -w @open-inspect/control-plane`                                                  | 0; no errors or warnings                                                   |
| `npm run test:lint-sandbox-boundaries`                                                         | 0; 2 tests passed                                                          |
| `npm run format:check`                                                                         | 0; entire repository passed                                                |
| `git diff --check`                                                                             | 0; passed                                                                  |

The Workerd skip is `cache-store-conformance.test.ts`, Cloudflare KV "reads null once the TTL has
passed": that backend does not offer the suite's controllable clock. It is preexisting and unrelated
to lifecycle verification; no new skip was introduced. No required command remains blocked. Workerd
prints deliberate eviction-test exceptions and NDJSON content-type warnings without test failures.
All application suites passed; the first full integration attempt needed a longer terminal budget,
not a test fix. The successful retry took 760.32 s. Final review moved deadline/hold assertions
outside the cleanup provider stub so intentional provider-error catches cannot swallow assertions on
failed attempts. The entire integration suite was then rerun successfully against that final test
version (647.39 s); no source/test edits followed final validation.

Additional validation:

- `npm test -w @open-inspect/control-plane -- src/sandbox/lifecycle/alarm-effects.test.ts --maxWorkers=1`:
  exit 0, 1 file / 28 tests.
- `npm run test:integration -w @open-inspect/control-plane -- sandbox-vm-reconciliation sandbox-state-retention --maxWorkers=1`:
  first exit 1 (3 new VM tests failed because fixture initialization retained a recent spawn
  timestamp, correctly invoking the existing spawn-throttle gate; 35 retention tests passed). The
  fixture resets its predecessor timestamp before the actual foreground reservation. Rerun exit 0, 2
  files / 38 tests. No production change or baseline suite failure was involved.
- `npx eslint eslint.config.js scripts/lint-sandbox-boundaries.test.mjs packages/control-plane/test/integration/sandbox-state-retention.test.ts packages/control-plane/test/integration/sandbox-vm-reconciliation.test.ts`:
  exit 0; checks the edited configuration/scripts/integration tests outside the package's
  `eslint src/` selection. All four typecheck configurations were also rerun after final assertion
  refinement.

## Related Work

At the audited checkout, COL-130/151/155/156/159 remain Backlog; existing socket names, boot-phase
helpers, shutdown phase projection, construction-policy defaults and old contracts are retained, not
opportunistically renamed/redesigned/deleted. COL-161 and COL-238 remain In Progress; spawn-time
context injection and PR #2141's heartbeat confirmation are not imported. COL-150's pure alarm
policy is reused. These issues are not closed, reparented or otherwise absorbed by this
verification.

Separately landed work since the research baseline includes Modal VM Docker-preparation/error/tunnel
lookup fixes (#2136/#2138/#2139), Modal save/termination handling (#2146), held-save alarm retries
(`8ed1aea`, #2152), model-catalog additions (#2147), identity/team authorization/secrets/grants and
repository-scoped installation credentials (#2179/#2180/#2181), and COL-226 restore credentials
(`f1cf069`, #2178). Their behavior is preserved and distinguished from extraction;
shared/web/backend contracts are not changed in T7. Recheck concurrent work at merge, not by
restoring the old baseline.

## Separate Gaps and Evidence Limits

Green characterization tests preserve current behavior; they do not endorse it as safe. Follow-up
behavior work should use scoped authorization and regressions, not silently extend this refactor:

- **Unmanaged ownership await and absent target:** the new inactivity reproducer replaces the row
  while `requestShutdown()` waits. On `unmanaged`, old work retires successor access/status and an
  absent captured handle falls back to the successor handle with the old timestamp. Follow up with
  immediate generation/ownership revalidation and an explicit-target stop contract preserving
  absence.
- **Connect-timeout publication:** the new stop-gate reproducer installs a ready replacement. Old
  completion persists its error on that row and broadcasts failure despite the row staying ready.
  Follow up with generation-scoped failure persistence/publication, not a universal teardown guard.
- **Fresh/restore access:** the existing real-SQL encryption/replacement reproducer shows unguarded
  per-artifact writes landing on a successor. Separately design generation-conditional artifact
  writes.
- **Prior retirement:** captured prior-handle stop followed by a replaced row can clear the current
  singleton handle. This remains distinct from matching rejected-cleanup completion; follow up with
  conditional clearing under the existing confirmation-required/best-effort policy.
- **Inherited partial boundaries:** access-clear/notify exceptions can skip detach; saved-resume
  secret-read failure before commit holds successful provider recovery; bridge access can commit
  before held lifecycle acceptance; pending sandbox/shutdown handle registration uses separate
  writes. Existing characterization and fault traces are not atomicity guarantees. Address each
  separately.
- **Scheduling/attachment:** inactivity warnings retain their full grace interval rather than the
  healthy-path heartbeat cap; final attachment identity recheck does not check status. Existing
  policy characterization and COL-238 remain separate work, not universal liveness guarantees.

Remaining evidence limits: no single assembled real-storage old-auth/second-reservation/hash race;
no actual base-image retry combined with an outstanding old bridge across hash publication; no full
Node-host lifecycle/alarm transport test beyond current runtime/storage conformance; no exhaustive
Workerd boot-budget/heartbeat-to-queue matrix. Existing complementary assembled/storage tests remain
useful but are not stronger combined-race or backend guarantees. The new VM tests use substituted
socket transport and public attachment/readiness operations, not the full upgrade/authenticator
path.

## Release and Rollback

Normal review and merge remain required; T7 is not yet integrated and this report does not close the
parent before merge. No schema migration, feature flag or deployment is required by extraction. No
provider canary, exactly-once execution, remote cancellation or guaranteed recovery is claimed.

If maintainers release, inspect existing launch/ready latency, breakers, access, rejected-cleanup
retries, holds and shared alarms. Provider-backed canaries are a release decision, not evidence from
Workerd substitutes. Roll back a coherent reviewed increment with dependent increments and
separately landed fixes accounted for; do not use an arbitrary old binary or destructive history
reset.
