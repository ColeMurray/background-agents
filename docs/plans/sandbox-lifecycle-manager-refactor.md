# Sandbox Lifecycle Manager Refactor

This is the ownership guide for the incremental
[COL-240](https://linear.app/colemurray/issue/COL-240/refactor-sandboxlifecyclemanager-into-focused-collaborators)
refactor. [ADR 0004](../adr/0004-sandbox-checkpoint-and-shutdown.md) governs lifecycle and durable
shutdown authority. The [characterization matrix](sandbox-lifecycle-refactor-baseline.md) records
compatibility evidence and separate behavior gaps, not fixes claimed by extraction.

## Ownership

Paths are relative to `packages/control-plane/src/`.

- `sandbox/lifecycle/manager.ts` remains the public readiness, work-admission and recovery boundary.
  It selects startup mode, reserves generation/token identity, sequences input awaits, registers
  pending handles through VM reconciliation, records recovery invocation, dispatches providers,
  claims results, rotates retry identity and owns failure/breaker accounting.
- `sandbox/lifecycle/launch-context.ts` owns environment reads, model/harness defaults, ordered
  repository fields, MCP/Slack lookup, persisted-setting normalization, timeout conversion, image
  scope selection, lookup/logging and explicitly requested best-effort invalidation.
- `sandbox/lifecycle/image-selection.ts` remains the pure fingerprint, harness/runtime compatibility
  and provenance evaluator. Launch context reuses it rather than reimplementing policy.
- `sandbox/lifecycle/sandbox-access.ts` owns artifact-write mechanics, terminal JWT signing/reuse,
  retirement and access notifications. It has no lifecycle state or eligibility authority.
- `sandbox/lifecycle/vm-startup-reconciliation.ts` owns pending-reference registration,
  lost-response lookup recovery and bridge lookup, including all five interleaving-sensitive
  bridge/auth fields. It reconciles an authorized attempt without owning startup admission or
  shutdown/recovery policy.
- `sandbox/lifecycle/allocation-cleanup.ts` owns stateless bounded late-result destruction,
  rejected-cleanup retry rearming and matching-handle completion. Rejection/claim authority,
  admission flags and prior-generation replacement retirement remain in the manager.
- `sandbox/lifecycle/provider-stop.ts` owns the shared local stop bound, abort/timer mechanics and
  explicit `confirmed`/`not_stopped` outcome contract, not either caller's retirement policy.
- `sandbox/lifecycle/watchdog-effects.ts` owns stateless connect-timeout, stale-heartbeat, stale
  snapshot/stop, boot-budget and inactivity effects. The manager captures alarm facts,
  evaluates/dispatches policy, schedules healthy/warning checks and owns the termination guard.
- `session/sandbox-repository.ts` owns conditional SQL and encrypted access storage.
  `session/sandbox-shutdown.ts` and `sandbox-shutdown-repository.ts` own the durable
  shutdown/checkpoint protocol, receipts, holds, source retirement and recovery.
- `session/components.ts` and `sandbox-lifecycle-adapters.ts` compose the existing graph. Consumer
  ports remain in `sandbox/lifecycle/ports.ts`; consumers do not gain launch, access or shutdown
  internals. Session access readers retain authentication/read eligibility and decryption rechecks.

Each increment must integrate before its successor; the manager is not intended to become a tiny
facade or lose lifecycle arbitration. Fatal/unresponsive termination, generic startup claims,
failure accounting and public checkpoint/admission/recovery policies remain manager
responsibilities.

## Launch Contract

`SandboxLaunchContext` is explicitly constructed as a class. Its constructor receives only a
two-method environment/repository reader, default model and MCP/Slack ports, provider metadata,
optional image lookup and lazy logger. These dependencies are held in readonly fields; the class
owns no mutable lifecycle state, storage/shutdown authority, provider operations, full-manager
reference or service locator. Construction does not read the session or resolve log context.

`AgentLaunchFields`, `RepositoryLaunchInputs` and `ResolvedSandboxSettings` name the return shapes.
Agent fields are explicitly mapped into provider configs. Repository payload fields are restricted
to the existing scalar identity/base branch and optional ordered member list; single-repo sessions
omit the list unless a base SHA requires it. Nested owners and immutable base SHAs remain intact.
`resolveSandboxSettings(session)` returns normalized/provider-filtered settings and the derived
timeout together, so callers cannot assemble that ordering incorrectly.

`resolveImageBuildScope(session, repositories)` is a plain synchronous function returning
`ImageBuildScope | null`. The manager awaits the promise-only lookup only for a non-null scope.
Environment scope takes precedence and never falls back to a repo image. Ad-hoc multi-repo and
repo-less sessions have no scope. An eligible scope keeps its existing await even when lookup is
disabled or the repository list is empty.

## Sequencing Invariants

- Reserve identity and shutdown ownership synchronously, invalidate old credentials, then publish
  the generation-conditional hash before asynchronous input work. No launch read moves ahead of it.
- Fresh: retire prior provider, env, agent/repositories, eligible image lookup, MCP, Slack,
  settings/timeout, pending registration, provider create.
- Restore: seed snapshot runtime authority, retire prior provider, env, agent/repositories, Slack,
  MCP, settings/timeout, pending registration, recovery-invoked recording, provider restore.
- Resume resolves only settings/timeout and its existing access contract. It gains no environment,
  repository, MCP, Slack or image work. Bridge settings remain after pending-reference eligibility.
- Lookup misses/errors never invalidate images. Only the manager's confirmed-unavailable branch
  requests best-effort invalidation and reserves a fresh identity/token for base-image retry.
  Transient provider errors retain valid images; saved-state failure never silently becomes fresh.
- Preserve provider claims, generation/hold checks, access-write atomicity, conservative lifetime
  provenance, undefined settings, milliseconds-to-seconds conversion and lazy session logging.

There is no universal startup pipeline. Independently landed context injection, construction safety
or provider recovery behavior must be preserved, not implemented or removed as incidental cleanup.
No schema, wire/runtime/provider-backend contract, timeout or retry policy changes are authorized.

## Access Contract

`SandboxAccess` receives only an artifact storage port, broadcast, socket observation/detachment,
the provider's resumable-stop capability check, dashboard URL builder and lazy logger. It owns no
mutable lifecycle flags, generation checks, signing-key retention, encryption key or full-manager
reference. Its constructor performs no dependency work.

Composition constructs repository/socket/messenger leaves, then access, then shutdown, then manager.
Shutdown receives a callback to `access.retireShutdownAccess()` directly; retirement clears access,
notifies clients, then detaches with the unchanged close code and reason. There is no manager
retirement forwarding method. URL-only retirement preserves credentials on resumable providers when
supported, falls back to full clearing otherwise, and always clears tunnels and notifies. Other
termination paths keep their own existing clear/detach order.

The manager calls individual `storeCodeServer`, `storeVnc`, `storeAndBroadcastTunnelUrls`,
`storeTtyd` operations for fresh/restore at their original await points. It still orchestrates
secret reads and atomic `completeProviderResume` writes for resume; VM reconciliation owns bridge
completion with an expected pending reference. These operations are intentionally not unified.
`reusableTtydToken` validates an already-read JWT synchronously so disabled terminal access does not
acquire a new await. `mintTtydToken` uses the transient launch key, existing session/sandbox claims
and the single terminal TTL. A hash-only restart or expired/missing JWT cannot renew access.

`broadcastSandboxDashboardUrl` and `broadcastProviderAccessIfConnected` preserve separate,
repeatable notifications, alongside tunnel notifications. The manager retains publication fallbacks
and caller-specific catches, including committed recovery's access failure treatment. Atomic
repository completion rechecks generation, status and fence after encryption; only bridge supplies
an expected pending reference. Fresh/restore per-artifact writes remain unguarded, as characterized
separately in the baseline gap notes, not silently hardened here.

## VM Reconciliation Contract

`VmStartupReconciliation` owns `bridgeResolution`, `bridgeRetryGeneration`, `bridgeStartupClaim`,
`bridgeResolvedStartup` and `vmStartupAuth`, with no duplicate manager state. The manager calls
`registerForegroundAuth`, `beginForegroundRetry` and `finalizeForeground` at the original points;
none exposes mutable state or a generic field setter. Registration retains the actual foreground
generation object. Foreground completion compares generation/claim object identity; bridge auth,
claim and queue checks retain their value comparisons. Retry drops old auth before reservation/hash
publication yields, then registers the replacement key after successful reservation. An older
finalizer cannot clear newer auth. Inconclusive foreground lookup hands off its claim and signing
key to a later equal-valued bridge; only the completing generation clears that key.

Dependencies are the existing provider create/pending/classification/lookup hooks, three repository
operations, pending/resolved shutdown-handle registration, session reading, launch-context settings,
terminal signing/access publication, lazy logger and optional background submission. The only
manager callback is `acceptResolvedStartup(generation, providerObjectId, lifetime)`, which invokes
the existing generic `claimProviderStartup`. That operation still clears admission pending, refuses
held-current adoption without destruction, conditionally commits, cleans unacceptable late results,
records lifetime and publishes announcements. Resume still uses that same manager operation.

The reconciler's bridge entry is synchronous and starts its background factory synchronously. An
in-flight lookup deduplicates equal generations and queues the latest newer generation; eligibility
is checked again before settings and provider work. Atomic bridge access completion still supplies
the expected pending reference, leaving post-encryption generation/status/fence/reference checks to
the repository. The cache projects only identity and lifetime, never credentials. Restart can
resolve permissible provider/access facts but cannot reconstruct a terminal signing key.

`createWithVmRecovery` returns `CreateSandboxResult | null`; `resolveUnknownVmStartup` returns
`ResolveSandboxResult | null`. Null abandons the foreground path, not evidence of absence or
permission to replay create. Lookup remains lookup-only with the original retry interval and
materialization bounds. `modalVmAllocationDetail` lives beside the Modal provider and unwraps the
same typed outcomes: `not_visible`, `other_generation` and unknown transport results remain
distinct. The boolean unknown-startup hook does not replace detail classification. Hook existence
alone does not enable VM behavior; standard Modal returns no pending allocation and does not
classify launch errors as VM-unknown. Conservative lifetime provenance and resolved-handle
replacement are unchanged.

Restore remains manager-orchestrated: await pending registration, synchronously record
`markRecoveryInvoked`, immediately invoke restore. No new await hides that durable boundary.
`startup-errors.ts` holds the two existing internal abandonment/expiry errors shared by reservation
and reconciliation, preserving the manager's distinct catches. No provider/backend/wire/persisted
contract or public consumer port changes.

Review follow-up explicitly corrects one inherited publication bug: a refused deferred bridge claim
no longer emits an access-change notification. Auth finalization and queued lookup draining still
run on refusal. This is a narrow behavioral fix, not a redesign of the extraction's contracts.
Access may still have committed before the manager observes a hold; this fix does not make access
and lifecycle acceptance atomic. Pending sandbox/shutdown registration also retains separate writes
without a cross-record transaction (the shutdown write precedes its alarm await). Failure atomicity
and unified acceptance require separately scoped safety work; neither is claimed fixed here.

## Allocation Cleanup Contract

`destroyLateProviderResult`, `rearmRejectedStartupCleanupAlarm` and `attemptRejectedStartupCleanup`
are stateless functions. Their narrow dependencies are a two-method repository port (`getSandbox`,
`updateSandboxModalObjectId`), the shared scheduler's `schedule`, explicit-stop eligibility, a stop
operation requiring a supplied handle and signal with a `confirmed`/`not_stopped` result, and a lazy
warning logger. Rearming and late destruction each accept only their dependency subset. The manager
constructs the readonly dependency wiring without invoking it; no manager reference, local ownership
flag, shutdown policy, new persisted record or raw platform alarm belongs to cleanup.

Rejection ordering remains manager-owned: recognize `SandboxLaunchRejectedError`, synchronously
`rejectProviderStartup` to fence credentials/socket authority and retain the handle, detach with the
existing code/reason, then clear/notify access. Only the repository result `failed` authorizes
failed-status/error publication and breaker accounting. `retained` preserves terminal status/error;
`superseded` does not touch the current row or access and only attempts bounded late destruction.
Generic `claimProviderStartup` still clears the pending admission flag and refuses a current held
generation without destroying its potentially unique recovery copy.

Rejected cleanup awaits retry scheduling before provider I/O. It stops the explicit target with
`startup_superseded`, `destroy`, the public session name/internal ID fallback and a bounded signal,
retaining the existing **undefined** `generationCreatedAtMs`. The provider adapter still interprets
absence; row age does not change pending-reference retirement classification on this path. The
original stop bound and abort/timer implementation live in `provider-stop.ts`; late destruction and
the manager's separate replacement-retirement operation both call `boundedProviderStop`. Timeout
error messages, logging, retry and handle-clearing policies remain with the callers.

Review follow-up corrects the inherited false-confirmation bug: the manager's stop adapter returns
`not_stopped` when no provider method, session context or target permits dispatch, and `confirmed`
only after the provider reports success. Rejected cleanup retains its handle/retry on `not_stopped`;
confirmation-required replacement on explicit-stop providers refuses an undispatched stop before
reserving a replacement. Best-effort replacement and providers without explicit stop retain their
existing handle-clearing/continuation policy. This is a narrow behavioral fix, not a new provider
absence rule or generalized teardown operation.

Failed, unsupported or locally timed-out cleanup retains the handle and scheduled retry. Abort
bounds local waiting only; eventual completion of a timed-out stop does not clear the handle. A
confirmed result clears only when sandbox ID, reservation timestamp and handle still match, without
retargeting to a newly read row. It does not clear the fence or `startup_rejected` marker. Manager
shutdown-alarm dispatch still prioritizes rejected cleanup over ordinary shutdown processing,
including holds, and production runtime reconstruction retains its existing rearm hook.

Generic superseded-result destruction remains bounded best effort rather than a new durable cleanup
record. The assembled alarm handler can retry a failed rejected cleanup twice per delivery because
it invokes shutdown processing before and after terminal-projection I/O, before generic watchdogs.
These inherited semantics, along with prior-generation unscoped clearing and access-retirement
failure boundaries recorded in the baseline, are unchanged; no stronger retirement/exactly-once
guarantee is claimed.

## Watchdog Contract

`failConnectTimeout`, `terminateStaleHeartbeat`, `snapshotAndStopStaleSandbox`, `failBootBudget` and
`stopForInactivity` are stateless functions. Their dependencies are narrowed storage, broadcast,
socket, shutdown and access ports plus named failure accounting/reporting, checkpoint triggering,
provider capability checks and generation-targeted best-effort stop operations. Each function takes
only its dependency subset; there is no manager reference, flag setter, scheduler or lifecycle
class. Construction does not call dependencies, and logger resolution remains lazy, including
detached snapshot rejection logging. Existing boot-phase parsing and failure text are reused without
new vocabulary, defaults or messages.

`handleAlarm` retains the initial shutdown hold check, pre-await sandbox/time/client/provider-handle
capture, ID-plus-reservation-timestamp generation predicate, `evaluateAlarmPolicy` dispatch,
healthy/warning scheduling and `SandboxAlarmResult`. `session/alarm/handler.ts` still prioritizes
shutdown before and after other alarm work and uses those same results to fail/redrive the queue.
The shared `AlarmScheduler` remains the only alarm/deadline owner.

- Connect timeout fails/counts/clears access before explicit stop, fences only when stop is
  available and the retained source is not held, then publishes status/error after stop. Without
  explicit stop, a late bridge may still self-heal the unfenced failed boot.
- Heartbeat retires incomplete boots without snapshotting, preserves provider-managed resumable
  state, and delegates shutdown-required ready-workspace capture to shutdown in emergency mode.
  Legacy ready-workspace capture precedes explicit destroy-stop, then runtime shutdown and final
  detach. Without explicit stop, capture stays detached. Existing hold/generation checks after
  awaited capture and generation checks after stop remain where they were; no new confirmation
  episode is introduced.
- Boot budget holds a failed retained source without runtime shutdown, fencing, detach or provider
  destruction. Otherwise it sends runtime shutdown, fences, fails/counts/retires access, publishes
  and persists the failure, then detaches. Only the manager's `stopBootBudgetSandbox` operation sets
  `isTerminatingSandbox`, awaits explicit destroy-stop and clears that same flag in `finally`.
  Concurrent spawn is excluded during that stop, not during earlier publication/detachment. Other
  watchdog paths intentionally do not acquire this guard; fatal termination keeps its own interval.
- Inactivity awaits shutdown ownership first and falls back only when unmanaged. Access retirement
  retains capability-based URL/secret rules. Resumable stop skips snapshot/runtime shutdown; legacy
  capture precedes runtime shutdown, explicit destroy-stop and final detach/warning. Existing
  post-capture hold/generation and post-stop generation checks remain unchanged.

Stops receive the observed provider handle and generation timestamp, not a replacement row's target.
This does not strengthen every current publication or ownership handoff: connect-timeout publication
after stop, legacy effects after unmanaged shutdown ownership, and retirement exceptions keep their
existing boundaries. The baseline's separate gaps remain separate behavior work, not extraction
fixes or exhaustive interleaving guarantees.

Related-work reconciliation at T6's starting `60930ce`: COL-245 is integrated via PR #2170, after
the launch/access/VM increments. COL-238 remains In Progress and PR #2141 is open/unmerged; its
proposed heartbeat confirmation is absent from this checkout and is not imported. COL-150's alarm
policy and the current COL-151 boot-phase helpers are reused unchanged. Recheck independently landed
heartbeat work when integrating subsequent increments.

## Verification

Keep direct narrow-dependency tests for input resolution and lookup effects. Keep assembled tests
for exact fresh/restore/resume payloads, reservation before asynchronous work, distinct integration
ordering, the no-await boundary for ineligible images, retry identity rotation and lazy bridge
settings. Image compatibility policy belongs to `image-selection.test.ts`; real-storage and Workerd
tests retain generation, shutdown and early-connect coverage.

Access coverage includes direct retirement/fallback/notification-order tests, assembled JWT and
resume/restart/bridge tests, committed recovery failure boundaries, real encryption interleavings
and real composition retirement/construction checks. Existing session access-reader and repository
tests remain independent; collaborator mocks do not replace assembled coverage.

VM coverage retains assembled lost-create/lost-restore, bridge-first/provider-first, late-token,
restart, visibility/transport bounds, fencing, queued-generation and lifetime tests. Direct
narrow-port tests add object-identity finalization, retry reset/new-token isolation, identity-only
cache reuse, post-await atomic-commit refusal without publication, successful older
lookup/latest-generation queueing, pending expiry/supersession and non-VM hook gating. Assembled
launch tests pin both successful restore marker order and absence of invocation after rejected
pending registration. Real repository encryption-race tests retain reference/generation rechecks;
direct commit substitutes do not replace them. ESLint prevents public consumers from importing VM
reconciliation internals.

Allocation cleanup coverage retains assembled rejection/repository tests and adds controlled
schedule/stop gates, local timeout followed by late completion, exact stop arguments, unsuccessful
provider results, skipped dispatch/missing session context, capability/method absence,
generation-ID/timestamp/handle replacement isolation, terminal failure-accounting ownership and
superseded results against a held successor. Existing real-storage held-current claim tests remain.
Workerd now reconstructs the production runtime over a persisted rejected row and durable shutdown
hold, exercises the actual rehydration hook/shared deadline storage, and confirms
failed/successful/repeated cleanup preserves the hold and recovery receipt. ESLint keeps cleanup
internals unavailable to public consumers.

Watchdog coverage retains all assembled manager/policy/effect suites and real-storage/Workerd alarm
recovery and shutdown checks. The boot-budget trace names failure accounting, access retirement,
status/error publication and persistence before detachment and guarded stop; actual spawn remains
blocked during stop and resumes after stop failure. Retained-source tests assert no send/detach and
no duplicate failure charge under the hold. Deferred heartbeat/inactivity stop tests independently
replace ID or timestamp for legacy and resumable providers and assert post-stop abandonment without
successor mutation, detachment or new publication. Deferred ordinary captures prove in-flight and
uncertain ownership blocks competing generic teardown and subsequent stop; inactivity ownership
tests pin the absence of fallback effects before a held/owned decision. These extend rather than
replace the existing half-boot/ready, destructive-snapshot, detached-capture, late-bridge,
checkpoint-replacement, queue-result, duplicate-alarm and shared-deadline tests. ESLint keeps
watchdog internals unavailable to public consumers.

`manager-shutdown.test.ts` isolates the assembled shutdown/recovery cases, including the committed
access/publication failure matrix, from the manager's orchestration suite. It retains real
manager/access/shutdown composition with test storage/provider ports; real SQLite and Workerd checks
remain separate. The baseline gap notes distinguish inherited unsafe outcomes from desired safety
guarantees; green characterization tests do not make those outcomes safe or authorize hardening in
this extraction.

Build shared first, then run sequentially from the repository root:

```bash
npm run build -w @open-inspect/shared
npm test -w @open-inspect/control-plane -- src/sandbox/lifecycle src/session/alarm src/session/sandbox-shutdown
npm run test:integration -w @open-inspect/control-plane -- session-lifecycle-alarm-recovery sandbox-early-connect sandbox-shutdown sandbox-state-retention
npm run typecheck -w @open-inspect/control-plane
npm run lint -w @open-inspect/control-plane
npm run test:lint-sandbox-boundaries
git diff --check
```

Check formatting of touched files. Record checkout details, exact command results and blockers in
the PR/issue handoff rather than this enduring ownership guide. Full-story/package/bundle checks
remain the final increment's scope. Provider substitutes are not live-provider verification, and
this refactor does not authorize deployment or claim exhaustive interleaving safety.
