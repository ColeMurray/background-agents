# ADR 0003: Session Snapshot Handoff

## Status

Accepted

## Context

Session hydration needs server-rendered state, stable timeline pagination, reconnect convergence,
and authenticated access to sandbox credentials. A retained revision log can provide incremental
resume, but it duplicates every session mutation into a second projection, adds per-socket revision
state, and requires retention, gap recovery, and dual-protocol fan-out.

The event replay is already bounded. Reconnect bandwidth is therefore predictable, while the
complexity and correctness cost of maintaining a second mutation log applies to every write.

## Decision

1. **The canonical database is the synchronization source of truth**
   - `GET /sessions/:id` returns a secret-free canonical snapshot for SSR.
   - Every WebSocket subscribe or reconnect receives one authoritative `subscribed` snapshot.
   - After subscription, existing semantic messages update the live view.

2. **The snapshot-to-stream handoff is synchronous**
   - Complete authentication and all asynchronous enrichment first.
   - Perform the final canonical SQLite snapshot read.
   - Send the snapshot and register/persist the socket without an `await` between those operations.
   - A mutation is therefore either included in the snapshot or delivered after registration on the
     ordered WebSocket stream.

3. **Timeline identity is independent from synchronization revisions**
   - Events retain stable `eventId` and `timelineSequence` envelopes for deterministic pagination.
   - No session-view revision, retained delta table, or per-socket applied revision is stored.

4. **Sandbox credentials stay outside the canonical snapshot contract**
   - Clients fetch credentials from authenticated `GET /sessions/:id/sandbox-access`.
   - `sandbox_access_changed` invalidates that access query.
   - The resource is limited to interactive sandbox services; integration credentials remain in
     their own domain-specific flows.
   - Credentials are never sent in snapshots or semantic WebSocket messages.

## Consequences

### Positive

- Session mutations have one durable representation instead of a canonical write plus a view delta.
- Reconnect correctness depends on one small handoff invariant rather than revision retention and
  catch-up state machines.
- The control plane, shared protocol, and web reducer have fewer synchronization branches.
- Stable event pagination and secret-free SSR remain intact.

### Negative

- Every reconnect transfers a bounded full snapshot instead of only missed revisions.
- SSR state can be briefly older than the authoritative socket snapshot.
- Rare state that lacks a semantic live message converges on reconnect rather than immediately.

## Follow-Up Rules

- Do not add a retained session-view delta log without measured reconnect-bandwidth evidence.
- Do not add asynchronous work between the final snapshot read and socket registration.
- Prefer an existing semantic message or a narrow invalidation signal for new live state.
