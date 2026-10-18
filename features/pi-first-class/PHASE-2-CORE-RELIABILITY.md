# Phase 2 core Pi reliability

This phase changes only the one-operation Open-Inspect bridge. It does not add Pi native inbox,
steering, forks, workspace capabilities, execution, MCP, providers, or diff UI.

## Dispatch state machine

SessionDO claims the message and migration-62 row before RPC. Every state change names its expected
prior state. A successful or duplicate Pi receipt marks the operation admitted only from
`dispatching`/`ambiguous`; it cannot overwrite `stopping`. A thrown RPC is ambiguous and remains
processing. The current object tracks the exact submit promise, so stop cannot conclude `not_found`
until it settles. After eviction, SessionDO looks up the same message/operation ID:

- `not_found`: restore pending and redrive the same ID;
- `queued` or `running`: keep the claim and mark admitted;
- `settled`: explicit aborted/withdrawn may settle stopped; every natural result goes through Pi's
  canonical terminal projector.

Stop always names the exact operation. False, throw, queued, running, or unavailable outcomes retain
the stop fence. Late results derive current processing state from storage rather than broadcasting
idle unconditionally. Terminal callbacks are scheduled once at the message commit; result recovery
does not schedule them again.

Projection probes run before final capture. `not_found` during the admission grace period leaves the
relay and accounting open, so a slow inner durable submit cannot freeze an empty terminal snapshot.

## Projection outbox

PiSessionDO appends immutable, operation-local projection sequences before delivery. Streaming
versions share a canonical display identity while each delivery has a distinct sequence. SessionDO
stores only the last acknowledged sequence on the operation row and upserts canonical timeline rows;
there is no per-event receipt table or production-dead cursor. Compactions use Pi task identity.
Lifecycle alarms drain after restart. At settlement PiSessionDO stops the relay and captures the
exact submission-entry range once, so a response-loss retry after a newer turn starts cannot stamp
newer data as the old operation. Required rows drain before terminal result. Transport/5xx retries;
deterministic 4xx is recorded once and fails closed. Lifecycle cost checkpoints run only while the
operation remains pending; settled/finalized retries use the frozen terminal usage/cost snapshot.
Terminal-result 4xx rejection is likewise permanent and cleans bounded state without callback
replay; transport and 5xx remain retryable. A durable rejection marker makes transient cleanup
failures retry cleanup without redelivering the terminal result.

## Cost and rollback

Pi's pinned provider prices each request before PiHarness accumulates durable usage across every
root/child conversation, tool, and compaction request. Open-Inspect stores the operation's
token/cost baseline plus its projected cost high-water, so eviction cannot reset cumulative cost.
Aggregate terminal tokens are never repriced, preserving request-level tiers. SessionDO's cumulative
accounting prevents duplicate events/results from charging twice. A capped session refuses an
unpriced model before admission, and a running cost crossing enters the exact Pi stop fence rather
than the sandbox stop coordinator.

Rollback disables new Pi creation but retains the Pi binding, migration 62, operation lookup/abort,
outbox drain, and bounded terminal tombstones. Existing sessions therefore continue, stop, project,
and delete without a destructive down migration.
