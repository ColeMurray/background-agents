# Pi Durable upstream parity: hibernation and telemetry

## Why this document exists

Upstream `@earendil-works/pi-durable` on `main` has moved ahead of the published release. Two
upstream capabilities matter to Open-Inspect, and Open-Inspect must stay compatible with both the
published release and the next one.

| Upstream capability                            | Published `1.3.0` | Upstream `main` |
| ---------------------------------------------- | ----------------- | --------------- |
| Serverless wake contract (`onWake`, `wake()`)  | Not published     | Published       |
| Harness telemetry (`HarnessOptions.telemetry`) | Not published     | Published       |
| `resume()`                                     | Published         | Published       |
| `whenBusy: "steer" \| "followUp" \| "reject"`  | Published         | Published       |
| `harness.submission(id)` reacquisition         | Published         | Published       |
| `harness.waitForTask(id)`                      | Published         | Published       |
| Deferred tools + `tool-search` export          | Published         | Published       |
| Hibernatable tools                             | Not yet           | In progress     |

`@earendil-works/pi-telemetry@1.3.0` **is** published and already ships as a dependency of
`@earendil-works/pi-ai@1.3.0`, so the telemetry _contract_ is usable today even though the Durable
harness does not consume it yet.

## What Open-Inspect does now

### Hibernation

`packages/control-plane/src/pi/pi-harness-wake.ts` implements the upstream wake contract against the
published release:

- `PiHarnessWake` is `{ active, at? }`, identical to upstream's `Wake`.
- The controller resumes the harness after a reopen and when a hibernated object wakes with pending
  work.
- `wake()` prefers the native contract when the installed harness exposes it, and otherwise derives
  the answer from Open-Inspect's own durable state.

The published `1.3.0` release keeps interrupted work pending but does not schedule it until
something asks for progress. A reopened Pi session therefore resumes explicitly, which is what makes
a Durable Object eviction or a hibernation recoverable instead of leaving a run parked.

`PiSessionDO` calls `resume()`:

- right after the harness opens,
- when a hibernated object wakes with pending operations,
- never after the harness closed, which the deletion path reaches.

### Telemetry

`packages/control-plane/src/pi/pi-telemetry.ts` defines a schema whose span vocabulary mirrors
upstream's `DURABLE_TELEMETRY_SCHEMA`, so Open-Inspect spans compose with Pi's own spans once the
harness exposes its telemetry option.

- Spans: `pi.durable.submit`, `pi.durable.phase`, `pi.open-inspect.latency`.
- `OpenInspectPiTelemetryContext` implements the published `TelemetryContext` contract and publishes
  spans as structured log records.
- `assertContentFreeAttributes` refuses content-shaped attributes before they reach a sink. Prompts,
  tool arguments, tool output, and credentials never reach a span.
- `packages/control-plane/src/pi/pi-trace.ts` derives one trace id per Pi operation from the shared
  message id, so every SessionDO and PiSessionDO hop of one operation correlates without new
  persisted state. The Pi-to-SessionDO hops send it as `x-trace-id`.

## The single upgrade point

When a release ships `onWake`, `wake()`, and `HarnessOptions.telemetry`:

1. Pass `onWake` to `Harness.open` in `PiSessionDO`; the wake controller then delegates to the
   native contract instead of deriving one.
2. Pass the same `TelemetryContext` to `Harness.open`; Pi's spans nest inside the existing
   Open-Inspect trace.
3. Delete the derived wake computation; keep the controller as the adapter.

No other Open-Inspect file changes, and no stored state is migrated.

## Rules that survive the upgrade

- Open-Inspect keeps its own authority boundaries. Pi telemetry is observability, never
  authorization.
- A span never carries content. The guardrail is enforced in code, not by convention.
- Hibernation must never change what a session is allowed to do. A durable snapshot still governs
  capability admission.
- The installed version is exact-pinned. An upgrade is its own reviewed change with its own canary,
  not a side effect of another feature.
