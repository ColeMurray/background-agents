# Sandbox Lifecycle Manager Refactor

This document records implementation ownership for
[COL-240](https://linear.app/colemurray/issue/COL-240/refactor-sandboxlifecyclemanager-into-focused-collaborators).
The parent issue contains the approved incremental design;
[ADR 0004](../adr/0004-sandbox-checkpoint-and-shutdown.md) governs public lifecycle and durable
shutdown authority. The [T1 characterization matrix](sandbox-lifecycle-refactor-baseline.md) records
compatibility evidence and separate existing behavior gaps, not fixes claimed by extraction.

## Integration Status

- T1 / COL-241 is integrated as `0ce9e9d` (PR #2144).
- T2 / COL-242 extracts launch inputs and image mechanics. Starting checkout: clean `7716838`,
  including the newer VM save/stop recovery fixes from PR #2146. Those changes are preserved.
- T3 through T7 remain subsequent serial increments: access, VM reconciliation, allocation cleanup,
  watchdog effects, then final composition/full verification. T3 requires integrated T2, not merely
  a passing local suite or an open PR.
- This design copy was absent at T2 start. These notes describe actual T2 ownership rather than
  claiming the parent design's future collaborators have already landed.

## Current Ownership

Paths are relative to `packages/control-plane/src/`.

| Owner                                                                     | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sandbox/lifecycle/manager.ts`                                            | Public readiness, work admission and recovery; startup mode selection; generation/token reservation; ordered input awaits; provider invocation, pending-handle registration and recovery-invoked recording; confirmed-unavailable base retry and identity rotation; provider claims; failure/breaker accounting; access, VM reconciliation, cleanup and watchdog orchestration still awaiting later extractions. |
| `sandbox/lifecycle/launch-context.ts`                                     | Stateless environment reads, model/harness resolution, ordered repository fields, MCP/Slack lookup, persisted-setting normalization, timeout conversion, image lookup/logging and explicitly requested best-effort invalidation.                                                                                                                                                                                 |
| `sandbox/lifecycle/image-selection.ts`                                    | Existing pure image fingerprint, harness/runtime compatibility and provenance evaluation, reused without duplicating its policy.                                                                                                                                                                                                                                                                                 |
| `sandbox/lifecycle/decisions.ts`, `alarm-policy.ts`, `shutdown-policy.ts` | Existing decision/policy functions.                                                                                                                                                                                                                                                                                                                                                                              |
| `session/sandbox-repository.ts`                                           | Conditional SQL and encrypted access storage; no changed atomicity or persistence format.                                                                                                                                                                                                                                                                                                                        |
| `session/sandbox-shutdown.ts`, `sandbox-shutdown-repository.ts`           | Durable shutdown/checkpoint protocol, receipts, holds, source retirement and recovery.                                                                                                                                                                                                                                                                                                                           |
| `session/components.ts`, `sandbox-lifecycle-adapters.ts`                  | Existing production graph and adapter wiring; lookup contracts now imported from their focused owner.                                                                                                                                                                                                                                                                                                            |

### Launch Input Interface

`createSandboxLaunchContext` composes stateless functions. Its reader exposes only
`getSessionRepositories()` and `getUserEnvVars()`. Its provider dependency is metadata only: `name`
and `supportsSandboxTimeout`, never provider operations. Configuration contains the default model
and optional MCP/Slack lookup ports. The optional image lookup remains provider-scoped in
composition. A lazy `getLogger()` uses the manager's existing session-scoped logger; construction
does not read the session or invoke a lookup.

The manager's constructor remains the assembled lifecycle boundary. Its config inherits the focused
`SandboxLaunchConfig`, but only the projected launch fields reach the collaborator. Session-row
selection, routing URL, reserved identity/token, launch mode, generation time and prior sandbox ID
remain manager inputs. No full-manager reference, lifecycle storage/shutdown port, flag setter,
provider-operation dependency or new consumer API is added to launch context.

Operations remain individually callable so extraction does not introduce an async universal startup
pipeline or a new await before provider registration:

- Fresh: reserve identity/hash, retire prior provider, env, model/repositories, eligible image
  lookup, MCP, Slack, settings/timeout, pending registration, provider create.
- Restore: reserve identity/hash, seed snapshot runtime authority, retire prior provider, env,
  model/repositories, Slack, MCP, settings/timeout, pending registration, recovery-invoked
  recording, provider restore. There is no fresh image lookup or silent fresh fallback.
- Resume: existing reservation/runtime handling, settings/timeout, optional recovery-invoked
  recording, provider resume and existing access completion. No env, repositories, MCP, Slack or
  image work.
- Bridge: existing pending-reference/generation eligibility checks precede settings/timeout
  resolution.

Launch context owns fresh image eligibility and returns synchronous `null` for ineligible scopes;
the manager conditionally awaits the returned promise without reconstructing that policy. Eligible
scopes retain their existing await even when lookup is disabled or the repository list is empty.
`resolveSandboxSettings(session)` normalizes and filters persisted settings before returning both
`sandboxSettings` and the derived `timeoutSeconds`; callers do not assemble that ordering
themselves. Launch lookup never invalidates a miss or lookup error. Only the manager's existing
`PrebuiltImageUnavailableError` branch explicitly requests invalidation, then reserves a new
identity/token for base-image retry. Transient provider errors retain the valid prebuild.

### Related Work And Limits

COL-161 remains In Progress at T2 inspection; no spawn-time prompt-context feature was implemented
or removed. Existing launch fields, immutable base SHAs, nested owners and repository ordering are
preserved. COL-156 remains Backlog: current production safety-policy wiring and dormant construction
behavior are retained; this increment does not claim to finish its broader constructor guarantees.
The T1 behavior gaps remain separate, including fresh/restore's existing unscoped artifact writes.

## T2 Verification

Node `v24.20.0`, npm `11.19.0`, installed dependencies. Commands ran sequentially from repository
root:

| Command                                                                                             | Result                                                        |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `npm run build -w @open-inspect/shared`                                                             | Passed.                                                       |
| `npm test -w @open-inspect/control-plane -- src/sandbox/lifecycle`                                  | Passed: 17 files, 549 tests, including 50 new cases.          |
| `npm run test:integration -w @open-inspect/control-plane -- sandbox-early-connect sandbox-shutdown` | Passed: 2 files, 20 tests, with Workerd provider substitutes. |
| `npm run typecheck -w @open-inspect/control-plane`                                                  | Passed all four TypeScript configurations.                    |
| `npm run lint -w @open-inspect/control-plane`                                                       | Passed.                                                       |
| `npm run test:lint-sandbox-boundaries`                                                              | Passed: 2 tests.                                              |
| Targeted `npx prettier --check` on all touched files                                                | Passed.                                                       |
| `git diff --check`                                                                                  | Passed.                                                       |

The first lifecycle run passed 546 tests and failed the new bridge-settings assertion because its
fixture still had an ineligible `pending` status. The fixture now uses `ready`; the full selected
directory passed on rerun. The first typecheck rejected a widened boolean in the new resume mock;
using the existing literal `true` convention fixed it, and typecheck passed on rerun. These were
test fixture/type errors, not baseline failures or production behavior changes.

Direct launch-context tests use narrow dependency mocks. New assembled-manager tests assert exact
fresh/restore/resume payloads and use deferred hashing/env/integration work to verify reservation
and ordered lookups. Existing image fallback/identity rotation, pending VM lifetime provenance,
early-connect and shutdown tests remain. The bridge regression checks lazy settings resolution at
the provider boundary. Review follow-up added two microtask-order cases for ineligible image scopes,
strengthened eligible-miss async-boundary assertions, and verifies normalized settings and their
timeout together. The commands above passed again after that follow-up. This is not exhaustive
interleaving proof, a full package/bundle sweep, deployment or live-provider verification;
final-story verification remains T7's scope.
