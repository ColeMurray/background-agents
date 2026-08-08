# Context Compaction Timeline Marker

## Problem

OpenCode can compact a long-running session by summarizing older conversation context and then
continuing the current prompt. Open-Inspect already handles this transition correctly inside the
sandbox runtime, but the session UI gives no indication that it happened. Users therefore cannot
tell when the agent continued with compacted context or distinguish that transition from ordinary
tool and model activity.

The sandbox runtime currently consumes OpenCode's `session.compacted` event in
`OpenCodePromptStream._apply_sse_event`. It sets `compaction_occurred`, clears a pending context
overflow, and permits the changed post-compaction message chain. The runtime also intentionally
suppresses the generated summary message. No corresponding sandbox event is emitted, so the fact of
successful compaction never reaches control-plane persistence, WebSocket clients, timeline
hydration, or the timeline renderer.

## Goals

- Show a concise marker at the chronological point where the active parent session successfully
  compacted context.
- Show the same marker for live activity, initial snapshot/subscription hydration, and paginated
  history.
- Persist the marker so it remains visible after reconnecting or reopening the session.
- Keep the event contract independent of OpenCode and the selected model provider.
- Preserve existing compaction recovery, summary suppression, and assistant output behavior.
- Roll the producer out without causing mixed-version control planes or web clients to reject live
  session messages.

## Non-Goals

- Displaying the generated compaction summary or adding it to assistant output.
- Estimating tokens removed, context size before or after compaction, duration, or cost.
- Splitting the final assistant response into visible pre- and post-compaction text blocks.
- Displaying compactions from embedded OpenCode child sessions beneath Task activity in the first
  release.
- Backfilling markers into sessions that compacted before the event existed.
- Surfacing OpenCode's separate pruning of old tool outputs. This plan covers successful session
  context summarization represented by `session.compacted`.
- Changing context limits, when OpenCode compacts, or which model generates the summary.
- Introducing a new database table, migration, feature flag, or user setting.

## Upstream Signal

Open-Inspect currently pins OpenCode `1.18.11`. In that version, the successful completion event is:

```json
{
  "id": "evt_...",
  "type": "session.compacted",
  "properties": {
    "sessionID": "ses_..."
  }
}
```

The schema is defined by OpenCode's `SessionCompactionEvent.Compacted`. OpenCode publishes it only
after compaction processing returns `continue`, so it is a success signal rather than an attempt
signal. Its payload contains only `sessionID`.

Relevant upstream sources for the pinned version:

- [OpenCode's compaction event schema](https://github.com/anomalyco/opencode/blob/v1.18.11/packages/schema/src/session-compaction-event.ts)
  defines `session.compacted` and its payload.
- [OpenCode's compaction implementation](https://github.com/anomalyco/opencode/blob/v1.18.11/packages/opencode/src/session/compaction.ts)
  publishes the event after successful processing and defines the internal compaction message and
  summary flow.

OpenCode may first emit `session.error` with `ContextOverflowError`, but that is not a universal or
successful compaction signal. Proactive compaction can happen without an overflow, and an overflow
can remain unrecovered. The UI marker must therefore be emitted from `session.compacted`, not from
the overflow announcement or from summary-message inference.

The same OpenCode HTTP/SSE protocol is used for Anthropic, OpenAI, xAI, OpenCode Zen, Z.AI, and
DeepSeek models. Those are model backends beneath OpenCode rather than separate agent protocols, so
provider-specific compaction adapters are not needed.

## Scope

The first release displays successful compaction of the parent OpenCode session processing the
current Open-Inspect prompt. The marker is associated with the control-plane `messageId` for that
prompt and appears as a normal item in the session timeline.

Child OpenCode sessions created by the Task tool are excluded initially. Their compactions do not
currently alter parent compaction state, and the upstream completion event supplies only a session
ID. Supporting child markers would require routing them through the child-activity correlation and
buffering rules so a marker can be nested under the correct Task. Keeping them out of the first
release preserves current child isolation and avoids showing unassociated implementation detail.

No database migration is required. Durable Object event rows already store an unrestricted event
type and JSON payload, associate events with a message, and order them with `timeline_sequence`.

## Event Contract

Add a message-associated variant to the canonical `sandboxEventSchema` in
`packages/shared/src/types/sandbox-events.ts`:

```ts
messageSandboxEventBaseSchema.extend({
  type: z.literal("context_compacted"),
});
```

The wire shape is:

```json
{
  "type": "context_compacted",
  "messageId": "msg_...",
  "sandboxId": "sandbox_...",
  "timestamp": 1786.0
}
```

Contract decisions:

- Use `context_compacted`, not the provider-specific `session.compacted`, because the shared event
  protocol describes Open-Inspect semantics rather than upstream wire names.
- Use past tense because the event represents confirmed successful completion.
- Require `messageId`; compaction occurs while handling a specific prompt and should remain
  filterable and attributable after timeline hydration.
- Use the standard runtime-added `sandboxId` and seconds-based `timestamp` fields.
- Do not include summary text. It is internal model context, can be large, and is deliberately
  hidden from user-visible assistant output.
- Do not add `reason`, token counts, or before/after sizes in the first version. The success event
  does not provide them. A preceding overflow could be correlated, but that would add inferred data
  not needed by the UI.
- Do not add a `compactionId` initially. Events are non-critical, are emitted once per upstream
  success event, and the runtime timestamp has sub-second precision. Multiple genuine compactions in
  one prompt remain separate rows because the control plane uses ordinary inserts rather than a
  per-message upsert.

Adding the variant automatically extends the derived `SandboxEvent`, `EventType`, `eventTypeSchema`,
event-list response schema, and live/timeline server message types.

## Sandbox Runtime

Update `OpenCodePromptStream._apply_sse_event` in
`packages/sandbox-runtime/src/sandbox_runtime/prompt_stream.py` at the existing `session.compacted`
branch.

For a compaction whose `sessionID` equals `state.opencode_session_id`:

1. Keep setting `state.compaction_occurred = True`.
2. Keep clearing `state.pending_overflow_error`.
3. Keep the existing structured `bridge.session_compacted` log.
4. Append one `context_compacted` bridge event containing `state.message_id`.

The event must be appended only for the parent session. A tracked child session or unrelated session
must not emit a parent marker or set parent compaction state.

The existing bridge loop already forwards every event produced by the prompt stream through
`BufferedEventForwarder`, which adds `sandboxId` and `timestamp`. No bridge command or transport
envelope change is needed.

Do not emit the marker from these weaker signals:

- `ContextOverflowError`, because the recovery may fail and proactive compaction may not emit it.
- A user part with `type: "compaction"`, because that represents creation or start, not success.
- An assistant message with `summary: true`, because failed summaries exist and the content must
  remain suppressed.
- Final-state fetching, because it is a loss-recovery path that does not expose a reliable new
  compaction occurrence and could duplicate a live marker.

## Delivery Semantics

Keep `context_compacted` non-critical for the first release. It receives the same bounded reconnect
buffering and at-most-once live delivery as ordinary tool and status activity. Once accepted by the
control plane, it is durably stored and available to timeline hydration.

Do not add it to `CRITICAL_EVENT_TYPES` in either the runtime or control plane without first
designing a unique acknowledgement identity. Current critical IDs use `{type}:{messageId}`; two
compactions during one prompt would collide and the later pending event could overwrite the earlier
one. Exactly-once compaction markers can be considered separately by adding a stable occurrence ID,
idempotent persistence, and acknowledgement after insertion.

This tradeoff is appropriate for an informational timeline marker and avoids broadening the first
release into a transport reliability change. Tests should still cover ordinary forwarding and
timeline hydration after successful persistence.

## Control Plane

The sandbox WebSocket boundary in `SessionDO.handleSandboxMessage` strictly parses events with the
shared `sandboxEventSchema`. Updating the shared contract is therefore required before a runtime can
emit the new variant.

After validation, allow `SessionSandboxEventProcessor` to use its existing generic event path:

1. Resolve `messageId` from the required event field.
2. Insert a new event row with `createEvent`.
3. Preserve the full JSON payload.
4. Broadcast `{ type: "sandbox_event", event }` to connected clients.

Do not use the token, tool-call, or execution-complete upsert paths. Multiple compactions can occur
within one prompt and each occurrence must remain visible. No special callback, snapshot, session
status, cost, or lifecycle side effect is required.

Do not change session activity semantics solely for this marker. Compaction happens while a prompt
is already processing and surrounding step/tool activity updates last activity. The event should
remain descriptive rather than becoming a new lifecycle signal.

Validate the optional event-list filter in
`packages/control-plane/src/session/http/handlers/messages.handler.ts` with the canonical
`eventTypeSchema` so `GET /internal/events?type=context_compacted` succeeds without maintaining a
second event catalog.

`SessionEventStream` excludes only heartbeats, so no timeline or history filtering change is needed.
The existing `timeline_sequence` ordering remains authoritative when storage timestamps tie.

## Web Timeline

Register a renderer for `context_compacted` in `packages/web/src/components/session-timeline.tsx`.
Use the existing `StatusRow` presentation with a neutral/muted tone and explicit text:

```text
Context compacted to continue
```

The marker is successful recovery behavior, not a warning or error. It should not use warning or
destructive styling, appear in the right-sidebar warning list, or change the current sandbox status
shown in the header.

The marker should include the standard visible timestamp. The dot remains decorative; the copy must
communicate the meaning without relying on color. No animation, expansion control, summary tooltip,
or user action is needed.

No special timeline grouping logic is required:

- `buildTimelineItems` retains non-tool events as standalone timeline items.
- The marker naturally flushes an adjacent tool group, visually preserving the compaction boundary.
- The ordinary event key includes event type, message or sandbox identity, and timestamp.
- Multiple markers in one prompt remain separate when their occurrence timestamps differ.
- Snapshot/subscription hydration and live ingestion both pass non-token events through unchanged.

The web client intentionally buffers cumulative assistant token events until execution completes and
collapses hydrated timeline entries to the final token for each message. Consequently, a marker can
appear during live processing before the final assistant card and retain its persisted position
during later hydration, but it cannot divide visible prose into before/after sections. That
limitation is acceptable because the marker communicates an execution transition rather than
exposing internal summary boundaries.

## Compatibility

The control-plane sandbox ingress and live web `sandbox_event` messages strictly validate the event
union. Snapshot/subscription timelines and history are more tolerant: unknown event variants are
dropped individually so an old event cannot wedge hydration.

Compatibility behavior is therefore:

- Old runtime with new control plane/web: no marker is emitted; all existing behavior continues.
- New runtime with old control plane: the event is rejected at sandbox ingress and is not stored.
- New control plane with old web client: timeline hydration drops the unknown marker. A live
  `sandbox_event` containing it fails strict server-message parsing, closes that client's WebSocket,
  and loses the non-critical marker; the client can reconnect and continue because the marker is a
  standalone event.
- New runtime, control plane, and web: marker is stored, broadcast, and hydrated.
- Historical sessions: no marker is synthesized for prior compactions.

Deploy the shared contract, control plane, and web client before enabling the runtime producer. This
avoids both temporary marker loss at sandbox ingress and avoidable disconnects for old live web
clients. If deployment order cannot be guaranteed, split deployment into a consumer change followed
by a runtime/image rebuild.

## Runtime Distribution

The implementation belongs only in `packages/sandbox-runtime`; do not duplicate it in individual
sandbox providers. Each provider packages the same runtime, but its baked artifact must be rebuilt
before new sandboxes can emit the event:

- Modal copies the runtime in `packages/modal-infra/src/images/base.py`.
- Daytona copies it in `packages/daytona-infra/src/toolchain.py`.
- E2B stages it in `packages/e2b-infra/build-template.py`.
- OpenComputer uploads it in `packages/opencomputer-infra/src/build-template.ts`.
- Vercel packages it through `packages/control-plane/scripts/build-vercel-base-snapshot.ts`.

Repository/environment images or restored snapshots built before rollout may continue using an old
runtime until rebuilt or replaced. During rollout, absence of a marker must therefore not be treated
as proof that no compaction occurred across all pre-existing sandboxes.

## Testing

### Shared Contract

Extend `packages/shared/src/types/boundary-schemas.test.ts` to verify:

- A complete `context_compacted` event parses and retains all fields.
- Missing `messageId`, `sandboxId`, or `timestamp` is rejected.
- A live server `sandbox_event` containing the marker parses.
- Initial snapshot/subscription timelines and `history_page` retain the recognized marker envelope.
- Existing tolerance still drops unknown timeline events without dropping recognized neighbors.

### Sandbox Runtime

Extend `packages/sandbox-runtime/tests/test_prompt_stream.py` to verify:

- Parent `session.compacted` updates state, clears a pending overflow, and emits exactly one marker.
- Proactive parent compaction emits the same marker without a preceding overflow.
- An unrelated session emits no marker.
- A tracked child-session compaction emits no parent marker and does not change parent state.
- Repeated genuine parent compactions produce separate events.
- An overflow followed by idle without successful compaction emits the existing error and no marker.

Extend `packages/sandbox-runtime/tests/test_bridge_sse.py` to verify:

- The bridge forwards the marker between surrounding pre- and post-compaction activity.
- Successful overflow recovery produces the marker and successful `execution_complete`.
- Failed compaction produces the existing error/completion behavior without a marker.
- Compaction summary text remains absent from token events.
- Post-compaction assistant text remains accepted.

No new event-forwarder acknowledgement tests are required because the marker remains non-critical. A
focused forwarding test may assert that the normal path adds `sandboxId` and a seconds-based
timestamp if existing generic coverage does not make that sufficiently clear.

### Control Plane

Extend `packages/control-plane/src/session/sandbox-events.test.ts` to verify:

- The event is persisted with its explicit `messageId` and full payload.
- The same event is broadcast to clients.
- It does not use an upsert path or trigger completion side effects.

Extend `packages/control-plane/test/integration/websocket-sandbox.test.ts` to send a marker through
the authenticated sandbox WebSocket and verify both its event-row persistence and client broadcast.

Extend `packages/control-plane/src/session/event-stream.test.ts` or
`packages/control-plane/test/integration/websocket-client.test.ts` to verify the marker appears in
initial timeline hydration and paginated history in chronological order.

Extend `packages/control-plane/test/integration/events-messages-list.test.ts` to verify filtering by
`type=context_compacted` returns the stored marker and no longer responds with `400`.

### Web

Extend `packages/web/src/lib/session-socket/event-log.test.ts` to verify a live marker passes
through without clearing or flushing pending assistant text.

Extend `packages/web/src/lib/session-socket/reducer.test.ts` to verify markers survive initial
snapshot/subscription hydration, live append, and history prepend without deduplication.

Extend `packages/web/src/components/session-timeline.test.tsx` to verify:

- The marker copy and timestamp render.
- The marker is neutral rather than warning/destructive content.
- A marker between same-name tool calls prevents grouping across the boundary.
- Multiple marker events render independently and in event order.

## Verification Commands

Build the shared package before its consumers, then run focused suites:

```bash
npm run build -w @open-inspect/shared
npm test -w @open-inspect/shared
npm test -w @open-inspect/control-plane -- src/session/sandbox-events.test.ts src/session/event-stream.test.ts
npm run test:integration -w @open-inspect/control-plane -- test/integration/websocket-sandbox.test.ts test/integration/websocket-client.test.ts test/integration/events-messages-list.test.ts
npm test -w @open-inspect/web -- src/lib/session-socket/event-log.test.ts src/lib/session-socket/reducer.test.ts src/components/session-timeline.test.tsx
cd packages/sandbox-runtime
pytest tests/test_prompt_stream.py tests/test_bridge_sse.py -v
```

Run package-level static checks after focused tests:

```bash
npm run typecheck
npm run lint
cd packages/sandbox-runtime
ruff check .
ruff format --check .
mypy src
```

The full test suite remains the final CI backstop.

## Rollout

1. Build the shared event contract first.
2. Deploy the control plane with schema acceptance, persistence coverage, and event-list filtering
   before the runtime producer.
3. Deploy the web client with live parsing and the timeline renderer before the runtime producer.
4. Confirm a synthetic or test marker is accepted, stored, broadcast, hydrated, and rendered.
5. Rebuild and deploy sandbox runtime artifacts for each enabled execution provider. Split producer
   deployment from the consumer change when infrastructure cannot guarantee this order.
6. Start new sessions on each enabled provider and verify a forced/synthetic OpenCode compaction
   reaches the timeline.
7. Monitor control-plane invalid sandbox-event logs during rollout for mixed-version rejection.

No change to the pinned OpenCode version is required.

## Observability

Retain the existing `bridge.session_compacted` structured runtime log with `message_id`. The control
plane already logs non-terminal sandbox event types, so receipt of `context_compacted` will be
visible through the normal event logging path.

Do not add prompt content, generated summaries, or inferred context metrics to logs. Additional
product analytics are unnecessary for the first release. If rollout diagnostics prove insufficient,
add a count of received compaction events grouped by sandbox provider/runtime version separately.

## Risks And Mitigations

- Mixed-version live clients can reject the new event. Mitigate by deploying shared/control-plane
  and web consumers before rebuilding runtime producers.
- A non-critical marker can be lost during a narrow transport failure window. Accept the same
  delivery semantics as ordinary activity for the first release; add occurrence IDs and ACK-aware
  idempotency only if product requirements demand exact delivery.
- Multiple compactions can occur in one prompt. Persist each with `createEvent`; never upsert by
  `messageId`.
- Internal summaries could leak if the event is inferred from text. Emit only from
  `session.compacted` and preserve existing summary filtering.
- Old runtime images can make provider behavior appear inconsistent. Rebuild every enabled provider
  artifact and account for restored/cached images during rollout verification.
- Timeline placement may not align with the final assistant text card because tokens are buffered.
  Define the marker as an execution-history transition and avoid claiming it separates visible
  prose.

## Acceptance Criteria

- A successful parent `session.compacted` event produces exactly one `context_compacted` sandbox
  event for that occurrence.
- Failed or unconfirmed compaction produces no success marker.
- Child-session compaction does not create a parent marker.
- The control plane accepts, stores, message-associates, broadcasts, filters, hydrates, and
  paginates the event without a database migration.
- The session timeline displays `Context compacted to continue` at the event's chronological
  position with a visible timestamp and neutral styling.
- The marker remains visible after reconnecting, reopening the session, and loading older history.
- Multiple successful compactions in one prompt remain separate timeline markers.
- Compaction summary content remains absent from user-visible output and stored marker payloads.
- Existing sessions, old runtimes, and sessions without compaction continue to behave unchanged.
- Shared, runtime, control-plane, integration, and web tests pass, followed by repository static
  checks.

## Implementation Order

1. Add and test the shared `context_compacted` event variant.
2. Add control-plane filtering and persistence/broadcast/hydration tests using synthetic events.
3. Add the web renderer and live/hydration/history tests.
4. Emit the event from the existing parent `session.compacted` runtime branch and extend bridge
   compaction tests.
5. Run focused verification and full static checks.
6. Deploy consumers, then rebuild and deploy runtime producers across enabled sandbox providers.
