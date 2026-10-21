# Pi Durable upstream parity: hibernation, wake, and telemetry

## Why this document exists

Upstream `@earendil-works/pi-durable` on `main` is ahead of the published release. Open-Inspect must
stay compatible with both, and must not re-implement what upstream is about to ship. This records
what upstream actually says, checked against the upstream sources, and what Open-Inspect does about
each item.

**Last verified:** 2026-10-21, against `github.com/earendil-works/pi`, `packages/durable`
(`README.md`, `src/harness/types.ts`, `src/harness/task-graph.ts`, `package.json`) on `main`, and
against the published `@earendil-works/pi-durable@1.3.0` in `node_modules`.

## The upstream state

Upstream `main` still carries the version `1.3.0` in its `package.json`, so the published package
and the branch share a version number while differing in content. The published `1.3.0` on npm is
unchanged since the last check.

| Upstream capability                                   | Published `1.3.0` | Upstream `main` | Open-Inspect          |
| ----------------------------------------------------- | ----------------- | --------------- | --------------------- |
| Serverless wake contract (`onWake`, `wake()`)         | Not published     | Published       | Adapted, see below    |
| Harness telemetry (`HarnessOptions.telemetry`)        | Not published     | Published       | Conforms              |
| `DURABLE_TELEMETRY_SCHEMA`                            | Not published     | Published       | Mirrored              |
| `resume()`                                            | Published         | Published       | Used                  |
| `whenBusy: "steer" \| "followUp" \| "reject"`         | Published         | Published       | Used                  |
| `harness.submission(id)` reacquisition                | Published         | Published       | Used                  |
| `harness.waitForTask(id)`                             | Published         | Published       | Used                  |
| Deferred tools and the `tool-search` export           | Published         | Published       | Not adopted           |
| `settings.restartLimit`, `retryTask`, `restart_limit` | Not published     | Published       | Not available yet     |
| `settings.afterFailedRun`                             | Not published     | Published       | Upstream default kept |
| `modelTools`                                          | Not published     | Published       | Not adopted           |
| `outputLimits`, `prepareArguments`, `control.handoff` | Not published     | Published       | Not adopted           |
| `contextRetentionMs`, `documentRetentionMs`           | Not published     | Published       | Not adopted           |
| Hibernatable tools                                    | Not present       | Not present     | Nothing to do yet     |

### The wake contract, exactly as upstream states it

Upstream `main` defines:

```ts
export type Wake = { readonly active: boolean; readonly at?: number };

export interface HarnessOptions {
  readonly onWake?: (wake: Wake) => void;
}

export interface Harness {
  wake(): Wake;
  resume(): void;
}
```

and the documentation says: _"Wakes the process for sleeping tasks instead of a `setTimer` timer.
Without it, while scheduling runs, a timer that keeps the process alive resumes sleeping tasks when
they are due. With it, the Harness arms no timer for them: it calls `onWake` after open and whenever
`Harness.wake()` changes, and the host arms its own wakeup, such as a Durable Object alarm, and
calls `resume()` when it fires. Called off the Session line, after the commit that changed the
value, so a host arms a recovery wakeup before calls that can start work. It may call `wake()` and
`resume()`, and must not block."_

The same source says of `setTimer`: _"Default `setTimeout`, with background timers unreferenced, or
**declined in Cloudflare Workers** and where they cannot be unreferenced."_ So on a Durable Object
the harness does not keep itself alive; the host owns the wakeup.

**Open-Inspect's shape matches upstream exactly.** `PiHarnessWake` in
`packages/control-plane/src/pi/pi-harness-wake.ts` is `{ active, at? }`, which is upstream's `Wake`
field for field, and the controller prefers the native `wake()` when the installed release exposes
it.

### Who owns the physical alarm in Open-Inspect

**The Cloudflare `agents` SDK, not Open-Inspect.** `PiSessionDO` installs
`Lifecycle.install(this).use(this.harness)`, where `this.harness` is the SDK's `PiHarness`. That
harness keeps one `Lifecycle` job per session: the job waits while pi has live tasks, reschedules
itself as a heartbeat, and completes when there are none. The `Lifecycle` derives the physical
Durable Object alarm from its job queue and installs the object's `alarm` handler. Upstream's own
`agents` documentation states the guarantee: _"An eviction mid-run leaves the job due, so its alarm
restarts the object, pi reopens and resumes its own tasks, and the job waits again."_

Two consequences Open-Inspect must keep:

1. **Open-Inspect must never arm the alarm itself.** The `Lifecycle` owns the physical alarm; a
   second owner would overwrite it. `pi-harness-wake.ts` therefore never calls `setAlarm` and never
   deletes one. It is the _resume_ seam, not the alarm owner.
2. **`PiSessionDO.onStart()` resumes the harness** when a hibernated object wakes with pending
   operations, before it reattaches its relays, so a run that lost its instance continues.

### Telemetry

Upstream `main` adds `HarnessOptions.telemetry`, which accepts a host-owned `TelemetryContext` from
`@earendil-works/pi-telemetry`, and exports `DURABLE_TELEMETRY_SCHEMA` describing its typed spans,
events, and metrics. The published `@earendil-works/pi-telemetry@1.3.0` already ships the contract,
so the interface is usable today even though the Durable harness does not consume it yet.

`packages/control-plane/src/pi/pi-telemetry.ts` conforms to that published contract: it uses
`defineTelemetrySchema` and implements `TelemetryContext`, and its span vocabulary mirrors
upstream's `DURABLE_TELEMETRY_SCHEMA` so Open-Inspect spans compose with Pi's own once the option
exists.

- Spans: `pi.durable.submit`, `pi.durable.phase`, `pi.open-inspect.latency`.
- `assertContentFreeAttributes` refuses content-shaped attributes before they reach a sink. Prompts,
  tool arguments, tool output, and credentials never reach a span.
- `packages/control-plane/src/pi/pi-trace.ts` derives one trace id per Pi operation from the shared
  message id, so every SessionDO and PiSessionDO hop of one operation correlates without new
  persisted state. The Pi-to-SessionDO hops send it as `x-trace-id`.

## What Open-Inspect deliberately does not adopt

Each of these is an upstream convenience that would move authority away from Open-Inspect or add a
surface the product does not have. They are decisions, not gaps.

| Upstream feature                   | Why Open-Inspect does not use it                                                                                                                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `modelTools`                       | It narrows what the model is offered at the harness level. Open-Inspect enforces the same rule as authority: the Code Mode restriction is the policy delegate's, backed by the durable parent registry. |
| `deferred` tools and `tool_search` | A tool that loads other tools by name is a model-reachable way to widen the tool set. Open-Inspect's tool set is small, explicit, and installed per session.                                            |
| `settings.afterFailedRun`          | Open-Inspect keeps upstream's default, `keep`: a failed turn leaves the queued prompts queued, which is the existing Open-Inspect behavior for a failed turn.                                           |
| `outputLimits`, `prepareArguments` | They shape a tool's ergonomics, not its authority. Open-Inspect's own tool layers already bound their results.                                                                                          |
| `contextRetentionMs`               | A memory optimization. The Durable Object's own eviction, and the `agents` wake job, already decide when memory is released.                                                                            |
| `control.handoff` from a tool      | Open-Inspect's handoff is a session lifecycle action with its own audit, reached through the control route, not a tool result. The upstream `handoff` control is a Pi-internal detail.                  |

## The Cloudflare Agents SDK's Pi harness, and the one upgrade it implies

Cloudflare announced the `PiHarness` beta in the Agents SDK on 2026-10-02
(`https://developers.cloudflare.com/changelog/post/2026-10-02-pi-harness/`). The architecture it
describes is the one Open-Inspect already runs:

- **Pi Durable provides the harness; the Lifecycle keeps it running in the Durable Object.** That is
  exactly `PiSessionDO`: `Lifecycle.install(this).use(this.harness)` on a plain `DurableObject`,
  with the harness's factory opening `Harness.open` over the object's own storage.
- **Extensions are Pi Durable's own.** `PiHarness` does not wrap them, so every Pi Durable extension
  feature works. Open-Inspect's tool-policy extension, its effect registry, and its per-slot
  contributions are all plain Pi extensions installed on the registry before `Harness.open`.
- **The SDK's skills extension is the one Open-Inspect uses.**
  `packages/control-plane/src/pi/managed-skills-extension.ts` installs `skills(sources)` from
  `agents/harness/pi` over Open-Inspect's _pinned_ session manifest, so the catalog resolution, the
  activation, the resources, and the prompt rendering are the SDK's, and only the _source_ is
  Open-Inspect's authority.
- **The Computer workspace and the browser** are the same primitives the SDK's example uses
  (`@cloudflare/computer`'s `Workspace`).

### The one place Open-Inspect lags: `agents` 0.28.1 against 0.29.0

Open-Inspect pins `agents` at exactly `0.28.1`. The latest is `0.29.0`. Checked against both
tarballs (2026-10-21):

| Surface                                      | 0.28.1 (installed) | 0.29.0 (latest)        | Change for Open-Inspect               |
| -------------------------------------------- | ------------------ | ---------------------- | ------------------------------------- |
| `agents/harness/pi` exports                  | —                  | adds `InputEntry` only | none                                  |
| `agents/mcp/client` exports                  | —                  | **identical**          | none                                  |
| Lifecycle `install`/`use`/`start`/`fetch`    | —                  | **identical**          | none                                  |
| The pi harness's tool result field           | legacy `content`   | `output`               | the adapter below becomes unnecessary |
| `@earendil-works/pi-ai` / `pi-durable` peers | `^1.0.0`           | `~1.3.0`               | aligns with Open-Inspect's 1.3.0 pin  |

So the upgrade is **API-identical for everything Open-Inspect uses**, and it would let Open-Inspect
**delete its own compatibility shim**: `adaptLegacyToolOutput` in `managed-skills-extension.ts`
exists only because Agents 0.28.1 was compiled against a Pi Durable that returned `content` instead
of `output`.

**It is deliberately not done in this change.** Two reasons, both of them the repository's own
rules:

1. **The pin rule.** "The installed version is exact-pinned. An upgrade is its own reviewed change
   with its own canary, not a side effect of another feature." The upgrade belongs in its own
   change, with its own canary.
2. **It changes the shipped worker's dependency graph.** Agents 0.29.0 imports
   `@modelcontextprotocol/sdk/types.js` (the v1 layout) while Open-Inspect ships
   `@modelcontextprotocol/client@2.3.1` (the v2 layout). The upgrade therefore needs the
   `@modelcontextprotocol/sdk@1.32.1` peer installed alongside it, and the worker bundle's
   resolution changes with it. In this checkout npm's resolver also fails on the peer change
   ("Cannot read properties of null (reading 'edgesOut')") unless it runs with `--legacy-peer-deps`.

**The upgrade, when it is taken, is one line plus its verification:** bump `agents` to `0.29.0`,
install with `--legacy-peer-deps`, add the `@modelcontextprotocol/sdk@1.32.1` peer, delete
`adaptLegacyToolOutput` and the rename guard, and run the full lanes plus the worker build. The
bundle check (`src/worker-build.test.ts`) is the one that catches a resolution mistake like this
one, and it failed loudly on the attempt — which is the point of having it.

## The single upgrade point

When a release ships `onWake`, `wake()`, and `HarnessOptions.telemetry`:

1. Pass `onWake` to `Harness.open` in `PiSessionDO`; the wake controller then delegates to the
   native contract instead of deriving one.
2. Pass the same `TelemetryContext` to `Harness.open`; Pi's spans nest inside the existing
   Open-Inspect trace.
3. Delete the derived wake computation; keep the controller as the adapter.

No other Open-Inspect file changes, and no stored state is migrated.

Two upstream additions to pick up when the release carries them:

- `settings.restartLimit` parks a task that was cut off too many times, with the reason
  `restart_limit`, and `harness.retryTask(id)` runs it again. The published release has neither the
  limit nor the reason. Open-Inspect's sanitized inspection already names the reasons the published
  release has (`missing_task`, `task_too_old`, `migration_failed`), so the parked reason arrives in
  the same place with no new surface.
- `DURABLE_TELEMETRY_SCHEMA` can replace the mirrored vocabulary in `pi-telemetry.ts` verbatim.

## Rules that survive the upgrade

- Open-Inspect keeps its own authority boundaries. Pi telemetry is observability, never
  authorization.
- A span never carries content. The guardrail is enforced in code, not by convention.
- Hibernation must never change what a session is allowed to do. A durable snapshot still governs
  capability admission.
- The installed version is exact-pinned. An upgrade is its own reviewed change with its own canary,
  not a side effect of another feature.
- One alarm owner. The `agents` `Lifecycle` owns the physical alarm; Open-Inspect owns the resume.
