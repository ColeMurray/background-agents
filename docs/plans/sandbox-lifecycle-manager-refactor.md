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
  pending handles, records recovery invocation, dispatches providers, claims results, rotates retry
  identity and owns failure/breaker accounting.
- `sandbox/lifecycle/launch-context.ts` owns environment reads, model/harness defaults, ordered
  repository fields, MCP/Slack lookup, persisted-setting normalization, timeout conversion, image
  scope selection, lookup/logging and explicitly requested best-effort invalidation.
- `sandbox/lifecycle/image-selection.ts` remains the pure fingerprint, harness/runtime compatibility
  and provenance evaluator. Launch context reuses it rather than reimplementing policy.
- `session/sandbox-repository.ts` owns conditional SQL and encrypted access storage.
  `session/sandbox-shutdown.ts` and `sandbox-shutdown-repository.ts` own the durable
  shutdown/checkpoint protocol, receipts, holds, source retirement and recovery.
- `session/components.ts` and `sandbox-lifecycle-adapters.ts` compose the existing graph. Consumer
  ports remain in `sandbox/lifecycle/ports.ts`; consumers do not gain launch or shutdown internals.

Access, VM reconciliation, allocation cleanup and watchdog effects remain manager responsibilities
until their serial extraction increments land. Each increment must integrate before its successor;
the manager is not intended to become a tiny facade or lose lifecycle arbitration.

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

## Verification

Keep direct narrow-dependency tests for input resolution and lookup effects. Keep assembled tests
for exact fresh/restore/resume payloads, reservation before asynchronous work, distinct integration
ordering, the no-await boundary for ineligible images, retry identity rotation and lazy bridge
settings. Image compatibility policy belongs to `image-selection.test.ts`; real-storage and Workerd
tests retain generation, shutdown and early-connect coverage.

Build shared first, then run sequentially from the repository root:

```bash
npm run build -w @open-inspect/shared
npm test -w @open-inspect/control-plane -- src/sandbox/lifecycle
npm run test:integration -w @open-inspect/control-plane -- sandbox-early-connect sandbox-shutdown
npm run typecheck -w @open-inspect/control-plane
npm run lint -w @open-inspect/control-plane
npm run test:lint-sandbox-boundaries
git diff --check
```

Check formatting of touched files. Record checkout details, exact command results and blockers in
the PR/issue handoff rather than this enduring ownership guide. Full-story/package/bundle checks
remain the final increment's scope. Provider substitutes are not live-provider verification, and
this refactor does not authorize deployment or claim exhaustive interleaving safety.
