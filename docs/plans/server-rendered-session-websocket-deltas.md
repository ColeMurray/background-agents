# Server-Rendered Sessions With WebSocket Deltas

## Status

Proposed

## Problem

The session detail route currently renders no authoritative session data on the server.
`packages/web/src/app/(app)/session/[id]/page.tsx` is a client component, `AppAuthBoundary` waits
for browser-side authentication, and `useSessionSocket` starts empty. Useful content appears only
after hydration, an auth request, a WebSocket-token request, and a WebSocket snapshot.

The target is an authenticated server-rendered session view followed by ordered WebSocket changes.
The handoff must not miss updates between the server read and browser subscription, and reconnects
must converge without always replacing the page with another full snapshot.

## Goals

- Render the header, recent timeline, artifacts, and session metadata in the initial response.
- Continue from the exact local SessionDO revision represented by that response.
- Preserve multi-client behavior, history pagination, prompt commands, and reconnect recovery.
- Fall back to an authoritative snapshot when a delta range is unavailable or invalid.
- Keep existing clients working throughout a mixed-version deployment and rollback.
- Keep authenticated data uncached and exclude sandbox access credentials from HTML/Flight data.

## Non-Goals

- Server-rendering presence, typing state, terminal contents, diffs, overlays, or the entire
  sidebar.
- Making session pages public or cacheable.
- Replacing backward history pagination with an unbounded initial payload.
- Changing progressive assistant-text behavior in this project.
- Making live-only notifications durable unless they are explicitly promoted into the projection.

## Current Constraints

### Web

- The session route is entirely client-owned and gets its ID through `useParams()`.
- `AppAuthBoundary` hides server-rendered children until `/api/auth/get-session` resolves.
- `useSessionSocket` cannot accept initial data.
- The reducer replaces state, events, and artifacts on every current `subscribed` message.
- The transport validates against one `ServerMessage` union and drops unknown messages.

### Control Plane

- `SessionDO.handleSubscribe()` separately reads state, artifacts, and replay before sending a full
  snapshot.
- Existing state, event, and artifact HTTP endpoints neither share a boundary nor return one common
  `SessionState` contract.
- `timeline_sequence` orders durable events backward through history; it is not a forward cursor for
  state and artifact changes.
- Several WebSocket messages are notifications rather than durable mutations. Token and tool events
  are durable upserts, while `step_start` and `step_finish` are currently live-only.
- The current socket is registered as authenticated before snapshot construction finishes, allowing
  a live message to race with and then be replaced by the snapshot.

Independent calls to the existing HTTP endpoints followed by the existing socket are therefore not a
safe handoff. The design needs one bootstrap boundary and a separate monotonic view revision.

## Core Model

### Two Ordering Domains

Keep the existing timeline sequence and add a session-view revision:

- `timeline_sequence` is a stable identity/order key for durable timeline rows and older-history
  pagination.
- `viewRevision` is a nonnegative safe integer ordering changes to SessionDO-local projections used
  by the current session view.

Revision `0` represents the projection of a session when this migration is installed. The first
post-migration canonical mutation is revision `1`; historical deltas are not synthesized.

### Bootstrap Contract

Add a shared `SessionBootstrap` schema in `@open-inspect/shared`:

```ts
interface SessionBootstrap {
  sessionId: string;
  viewRevision: number;
  state: SessionBootstrapState;
  artifacts: SessionArtifact[];
  replay: {
    events: SessionViewEvent[];
    hasMore: boolean;
    cursor: HistoryCursor | null;
  };
  spawnError?: string | null;
}
```

`SessionBootstrapState` is the existing shared `SessionState` projection with `codeServerPassword`
and `ttydToken` excluded. It may contain non-secret access URLs, but no bearer credential or
password is serialized into the React server response.

`SessionViewEvent` adds the stable storage identity needed for upserts:

```ts
interface SessionViewEvent {
  eventId: string;
  timelineSequence: number;
  event: SandboxEvent;
}
```

The same identity is returned by bootstrap, history pages, and event deltas. A mutable token or tool
row is replaced by `eventId`; it is never appended a second time merely because it was also loaded
through history. Timeline ordering continues to use `timelineSequence`, not update revision.

The bootstrap excludes presence, current-participant identity, typing state, WebSocket credentials,
and sandbox access credentials. It retains tolerant per-event parsing so one legacy event cannot
invalidate the page.

### View Operations

Do not persist arbitrary `ServerMessage` values as canonical deltas. Define explicit, idempotent
projection operations:

```ts
type SessionViewOperation =
  | { type: "state_patch"; patch: SessionStatePatch }
  | { type: "event_upsert"; item: SessionViewEvent }
  | { type: "artifact_upsert"; artifact: SessionArtifact };

interface SessionDelta {
  operations: SessionViewOperation[];
}
```

`SessionStatePatch` is a strict schema containing only mutable, non-secret state fields. It is not a
free-form partial object. One revision may contain multiple operations when one logical mutation
updates several projections, such as an artifact plus its timeline event.

Before implementation, inventory every existing reducer-affecting message and classify it:

| Current behavior                                      | Classification            | V2 behavior                                            |
| ----------------------------------------------------- | ------------------------- | ------------------------------------------------------ |
| Persisted event insert/upsert                         | Canonical                 | `event_upsert` with storage identity                   |
| Artifact create/update                                | Canonical                 | Atomic artifact and event operations where applicable  |
| Persisted title/status/branch/sandbox state/cost      | Canonical                 | `state_patch` committed with its write                 |
| `step_start`/`step_finish` timeline row               | Ephemeral today           | Legacy live event; may disappear on reconnect          |
| Sandbox warming/spawning notices before durable state | Ephemeral                 | Legacy notification until backed by a projection write |
| Presence/typing/pong/prompt acknowledgement/errors    | Connection/request scoped | Existing unrevisioned message                          |
| Diff/child change notification                        | SWR invalidation          | Unrevisioned signal; revalidate again on V2 readiness  |
| Snapshot notification                                 | Informational             | Existing unrevisioned message                          |

`step_finish` cost is different from its live timeline row: the durable total-cost update receives a
revisioned `state_patch`, while the currently ephemeral event remains best-effort.

Canonical mutation services, not the messenger, must own projection writes and delta insertion in
one transaction. A generic `recordAndBroadcastDelta()` wrapper around already-completed writes is
not sufficient. Existing mutation paths should be moved behind operations that:

1. Write the projection.
2. Increment `viewRevision` and insert the corresponding delta in the same synchronous transaction.
3. Broadcast only after commit.

Every visible persisted token and tool upsert consumes a revision in the initial implementation.
There is no checkpointing or compaction before correctness and volume are measured. Retention bounds
storage. A later optimization may redefine canonical in-flight token visibility, but it cannot
change a projection without advancing its revision.

## Control-Plane Design

### Storage

Add metadata and append-only delta tables to each SessionDO SQLite database:

```sql
CREATE TABLE session_view_metadata (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  current_revision INTEGER NOT NULL
);

CREATE TABLE session_view_deltas (
  revision INTEGER PRIMARY KEY,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

Add the schema to both `SCHEMA_SQL` and `MIGRATIONS` in
`packages/control-plane/src/session/schema.ts`. Retention removes only a contiguous oldest prefix.
Resume succeeds when:

- `resumeRevision === currentRevision`, including when no delta rows exist; or
- every revision in `(resumeRevision, currentRevision]` is present.

A missing interior revision, negative/unsafe integer, future revision, or revision older than the
retained prefix requires a snapshot. JSON boundary schemas require nonnegative safe integers.

Define retention count and age once as named constants. Initial values should be chosen after
measuring representative long-running sessions, especially token traffic.

### Atomic Bootstrap

Add authenticated `GET /sessions/:id/bootstrap` public and SessionDO internal routes. One
`ctx.storage.transactionSync()` closure copies the raw local session, sandbox, repository, artifact,
event-window, history-cursor, and revision values. The closure contains no `await`.

The atomic invariant is deliberately limited:

> The bootstrap contains all revision-controlled SessionDO-local projection changes at or below
> `viewRevision`.

Decryption is unnecessary because credentials are excluded. `environmentName` is resolved from D1
after the local snapshot and is a best-effort annotation outside the revision invariant. Other
configuration-derived annotations must be documented similarly or snapshotted locally if they need
revision semantics.

The endpoint uses `Cache-Control: private, no-store`, validates the shared schema, and never logs
payload bodies.

### V2 Subscription Protocol

Capability negotiation is explicit:

```ts
{
  type: "subscribe";
  token: string;
  clientId: string;
  viewProtocol?: 2;
  resumeRevision?: number;
  forceSnapshot?: boolean;
}
```

A new client can send these optional fields to an old server because the current Zod object parser
strips unknown keys. A new client must also continue understanding the legacy snapshot-shaped
`subscribed` message so WebSocket protocol rollback remains safe. HTTP API rollback is coordinated
separately because an old control plane does not have the bootstrap or access endpoints.

Use distinct V2 message discriminants rather than two incompatible `subscribed` schemas:

```ts
type SessionSyncStarted = {
  type: "session_sync_started";
  mode: "resume" | "snapshot";
  targetRevision: number;
};

type SessionDeltaMessage = {
  type: "session_delta";
  revision: number;
  delta: SessionDelta;
};

type SessionSnapshotMessage = {
  type: "session_snapshot";
  bootstrap: SessionBootstrap;
};

type SessionHistoryPage = {
  type: "session_history_page";
  items: SessionViewEvent[];
  hasMore: boolean;
  cursor: HistoryCursor | null;
};

type SessionReady = {
  type: "session_ready";
  sessionId: string;
  participantId: string;
  participant?: ParticipantSummary;
  appliedRevision: number;
};
```

`targetRevision` is informational and never advances the client revision. The connection is not
ready for prompts until `session_ready` arrives after all reconciliation data.

### Catch-Up Without Per-Socket Queues

Do not register or persist a V2 socket as authenticated/live until reconciliation completes. This
avoids unbounded in-memory queues and hibernation recovery of a half-synchronized socket.

For a valid resume:

1. Authenticate the token but keep the socket outside authenticated broadcasts.
2. In one no-`await` turn, capture current revision `H`, read the bounded contiguous delta range,
   send `session_sync_started`, send deltas through `H`, and send `session_ready` with
   `appliedRevision: H`.
3. After every send succeeds, register and persist the socket as live before yielding.
4. If any send fails, close the socket without a durable live mapping.
5. Send presence sync and broadcast presence.

No mutation can interleave inside that synchronous section. If the range exceeds a defined message
or byte limit, use snapshot mode rather than attempting an unbounded send.

For snapshot mode:

1. Keep the socket outside authenticated broadcasts while constructing a snapshot at revision `S`.
2. After any asynchronous annotation work, synchronously capture current revision `H` and read
   changes after `S` through `H`.
3. If the contiguous range is available and bounded, send `session_sync_started` with target `H`,
   send the snapshot and deltas, send `session_ready` at `H`, then register and persist the socket
   as live before yielding. Every send must succeed; otherwise close without a live mapping.
4. If retention or limits invalidate the range during snapshot construction, recapture the snapshot
   or close and reconnect. Do not register a partially reconciled socket.

Suspend the unauthenticated-socket timeout while an authenticated V2 reconciliation is actively in
progress. If the isolate resets before registration, no durable client mapping exists; the socket
times out or reconnects and safely starts over. A reset in the narrow synchronous interval after a
successful `session_ready` send but before mapping persistence can make the client transiently
ready, but no canonical mutation can interleave in that interval. The next failed heartbeat or
unexpected pre-readiness state causes reconnect. Client readiness, never mapping existence alone,
gates actions.

### Mixed-Version Delivery

During rollout, delivery is selected per authenticated socket:

- V1 socket: legacy full `subscribed` snapshot and original live `ServerMessage` variants.
- V2 socket: `session_sync_started`, snapshot/deltas, `session_ready`, and revisioned canonical
  updates. Existing ephemeral/request messages retain their original variants.

Canonical mutations therefore produce one stored `SessionDelta`, then encode either the legacy live
message or `session_delta` for each socket capability. Removing legacy encoding is a later cleanup
after old-client and rollback support are no longer required.

### Protocol Failure And Resync

Decode `session_delta` in two stages: validate the envelope and revision first, then validate the
delta body. An invalid body, unexpected revision, malformed snapshot, duplicate sync start, or
canonical message before synchronization triggers immediate recovery rather than a silent drop.

Recovery behavior:

1. Stop applying canonical messages after the first invalid condition.
2. Close the socket with a defined application protocol-error code.
3. Explicitly reconnect with `forceSnapshot: true` and no resume revision.
4. Keep the last valid rendered state visible but disable live actions until `session_ready`.

WebSocket delivery is not exactly once. The guarantee is idempotent application at most once per
connection revision and eventual convergence through replay or snapshot after reconnect.

### Access Credentials

Add an authenticated, `no-store` client-only session-access endpoint returning code-server and ttyd
credentials. The client fetches it after hydration; it is never part of `SessionBootstrap`,
`session_snapshot`, or the durable delta log.

Sandbox access changes send an unrevisioned `session_access_changed` invalidation. Missing that
signal is repaired by refetching access on every `session_ready`. This avoids persisting secrets in
delta payloads while ensuring reconnect convergence. Emit invalidation on credential creation,
rotation, sandbox replacement, and clearing. The client immediately clears cached credentials on
spawning/replacement and stopped, stale, or failed sandbox state; access-endpoint `404`/`409`
responses also authoritatively clear them rather than retaining stale values.

## Web Design

### Server Authentication

Use the existing `getServerAuthSession()` and `AuthenticationUnavailableError` from
`packages/web/src/lib/server-auth-session.ts` in the protected app layout. Catch only the explicit
unavailable error; redirect unauthenticated requests to `/login`.

Seed the exact `/api/auth/get-session` SWR key through a nested authenticated provider or
serializable auth context so hydration does not replace server-rendered children with a spinner.
Since `cookies()` makes the route dynamic, explicitly retain `cache: "no-store"` on bootstrap
requests and force dynamic rendering where required for both Vercel and OpenNext.

The current single-tenant policy permits any authenticated tenant user to access sessions. The
bootstrap endpoint must match existing state/events/artifacts and WebSocket-token behavior. A future
membership policy must tighten every path together; bootstrap alone must not introduce a different
authorization boundary. Under the current policy, normal route outcomes are `401`, `404`, and
retryable transport/`5xx` failures, not a session-membership `403`.

### Route And Client Split

Refactor the route into:

- A server `page.tsx` receiving `params`, fetching and validating bootstrap data, redirecting on
  `401`, calling `notFound()` on `404`, and preserving transport/`5xx` errors for a retryable route
  error.
- A client session component receiving `sessionId` and `initialBootstrap` and containing the current
  interactive page logic.

Do not silently fall back to an empty WebSocket-only page when the bootstrap fails.

### Reducer And Transport

Change `useSessionSocket(sessionId, initialBootstrap)` to initialize state, artifact/event maps,
history cursor, and `lastAppliedRevision` from the bootstrap. The transport sends `viewProtocol: 2`
and that revision.

Client rules:

- Apply `event_upsert` and `artifact_upsert` by stable ID; order events by `timelineSequence`.
- Apply only `lastAppliedRevision + 1`; ignore revisions at or below the last applied value.
- Treat a higher revision as a gap and force a snapshot reconnect.
- In resume mode, require deltas to start at `resumeRevision + 1` and finish at `targetRevision`.
- In snapshot mode, require the snapshot before any delta,
  `bootstrap.viewRevision <= targetRevision`, and the first delta at `bootstrap.viewRevision + 1`
  when revisions differ.
- Do not advance on `session_sync_started`; become ready only when `session_ready.appliedRevision`
  equals both `targetRevision` and the client's last applied revision.
- Treat every synchronization ordering violation as a protocol error and force a snapshot reconnect.
- Replace all canonical state on `session_snapshot` and clear stale history-request state.
- Reset ephemeral presence on reconnect and repopulate from `presence_sync`.
- Revalidate diff, child sessions, participant profiles, and session access on every `session_ready`
  so missed invalidation messages converge.
- Recognize the legacy `subscribed` snapshot and legacy live messages when connected to an old
  server.

Stable storage identity is guaranteed only by bootstrap/history/V2 messages from an upgraded server.
Legacy mode keeps the existing event-list and render-time deduplication path; it must not synthesize
IDs and claim they are durable. Moving from legacy mode to V2 starts with a V2 snapshot that
replaces legacy canonical state.

Socket closure keeps SSR content visible with a stale/disconnected indicator. Prompt and other live
actions remain disabled until synchronization is ready. The initial timeline skeleton belongs to the
route loading boundary, not WebSocket connection state.

Older-history pagination keeps its existing backward cursor. History and bootstrap use stable event
IDs, so a later mutable event delta replaces the same row regardless of which path loaded it.

## Required Changes By Package

### `packages/shared`

- Add `SessionBootstrapState`, `SessionBootstrap`, `SessionViewEvent`, strict view operations, and
  delta schemas.
- Extend subscribe with capability, resume revision, and forced-snapshot fields.
- Add distinct V2 synchronization messages and access invalidation.
- Add a V2 history page carrying stable event identities while retaining the legacy history message.
- Keep legacy server messages for compatibility.
- Add safe-integer, tolerant-event, stable-identity, and mixed-version schema tests.

Build shared before dependent packages.

### `packages/control-plane`

- Add revision/delta schema migration and retention.
- Inventory mutations and move canonical writes behind transaction-owning projection services.
- Return stable event identity and sequence from bootstrap/history.
- Add atomic bootstrap and client-only access endpoints.
- Add V2 catch-up without registering sockets early.
- Track socket capability in durable client mapping for hibernation recovery after readiness.
- Dual-encode canonical live updates for V1 and V2 sockets.
- Add envelope-first protocol validation and bounded snapshot fallback.
- Instrument bootstrap size/duration, delta volume, resume/snapshot reasons, retained range,
  protocol errors, and old-client usage.

### `packages/web`

- Resolve protected-layout auth on the server and seed the auth client state.
- Split the session route into server and client components.
- Add a no-store bootstrap fetcher and route error states.
- Initialize the reducer from bootstrap and normalize through boundary adapters.
- Implement V2 synchronization, stable upserts, gap recovery, and legacy fallback.
- Fetch sandbox access separately and revalidate it on readiness/invalidation.
- Keep rendered data visible during reconnects.
- Remove query-string metadata fallback only after the SSR route is fully deployed.

### Documentation And Operations

- Update `docs/HOW_IT_WORKS.md`, API docs, and `docs/DEBUGGING_PLAYBOOK.md`.
- Document migration, feature flags, compatibility, and rollback behavior in release notes.

## Implementation Sequence

1. **Mutation inventory and contracts** Classify every current server message and define stable
   operation schemas before changing storage.
2. **Revision storage and canonical mutation boundaries** Add migration, transaction-owned delta
   writes, retention, and dual legacy/V2 encoding.
3. **Control-plane V2 and APIs** Add capability negotiation, bounded replay/snapshot, final
   readiness, resync, atomic bootstrap, stable event identity, and separate credential retrieval.
4. **Web support behind disabled flags** Add the server route, V2 transport/reducer, and a separate
   legacy adapter without enabling SSR bootstrap initialization in production.
5. **Enable SSR and V2 together** Seed server auth and enable bootstrap initialization only when V2
   synchronization is enabled. Do not run the stable-ID reducer from bootstrap followed by a legacy
   replacement snapshot.
6. **Default and cleanup** Enable V2 after metrics are healthy. Remove legacy encoding and query
   metadata only in a later compatibility-breaking cleanup.

## Testing

### Shared

- Bootstrap and operation schemas round-trip every canonical variant.
- Unknown replay entries are dropped without invalidating the bootstrap.
- Revisions reject negative, fractional, and unsafe values.
- Old and V2 subscribe/message shapes parse independently.

### Control Plane

- A local bootstrap and revision are captured in one synchronous transaction.
- Projection and delta writes become visible together.
- Every persisted token/tool upsert advances revision and retains stable timeline identity.
- Resume returns a contiguous ascending range or selects snapshot; it never returns a partial range
  as success.
- `resumeRevision === currentRevision` succeeds with an empty delta table.
- Future, malformed, expired, interior-gap, and oversized ranges select snapshot.
- A mutation during asynchronous snapshot enrichment is included in the final catch-up.
- No mutation interleaves between final revision capture, send, and live registration.
- Every failed synchronization send closes without creating a live mapping.
- A reset before a successful ready send leaves no live mapping.
- A reset after the ready send but before mapping persistence cannot interleave a canonical mutation
  and causes reconnect when the unmapped socket stops making progress.
- Hibernation after readiness recovers protocol capability and authenticated mapping.
- V1 clients continue receiving legacy live updates while V2 clients receive deltas.
- New clients against an old server fall back to legacy snapshot/live handling.
- Access credentials never appear in bootstrap, snapshots, deltas, or logs.

### Web

- Initial bootstrap renders without a replay skeleton or auth hydration spinner.
- Stable event upserts replace rows loaded through bootstrap or history.
- Duplicate revisions are ignored; gaps and malformed final deltas force snapshot reconnect.
- `session_sync_started` does not enable prompts; `session_ready` does.
- Resume and snapshot ordering invariants reject missing, early, or out-of-range deltas.
- Snapshot fallback replaces stale canonical state and resets history loading.
- Disconnects preserve rendered content and disable live actions.
- Legacy server snapshots and live messages remain supported during rollback.
- Access refetches on readiness and invalidation.

### End-To-End

- Direct authenticated navigation returns useful HTML before WebSocket connection.
- A change between bootstrap and subscribe appears once and converges after reconnect.
- Fast reconnect resumes; an expired revision receives a snapshot.
- An isolate reset during reconciliation reconnects instead of exposing a half-ready socket.
- Mobile and desktop hydrate without mismatch warnings.
- Unauthorized and not-found responses expose no session data or access credentials.

Run the shared build first, then focused shared, control-plane unit/integration, and web tests.
Finish with repository typecheck, lint, and a production web build.

## Rollout

Use separate feature flags for bootstrap SSR and V2 synchronization. Deploy in this order:

1. Shared schemas, control-plane migration, canonical revisions, and dual encoding.
2. Bootstrap/access endpoints and V2 control-plane synchronization.
3. V2-capable web and SSR route code, with both flags disabled by default.
4. Enable bootstrap SSR and V2 synchronization together, then expand gradually using resume/snapshot
   and protocol-error metrics.
5. Legacy cleanup only after the rollback window closes.

WebSocket protocol rollback remains safe: a new client accepts an old server's legacy protocol, and
a new server keeps V1 clients on legacy live encoding. Full deployment rollback is coordinated:
disable SSR before rolling the control plane back past the bootstrap/access APIs, or retain those
APIs for the entire web rollback window. An ordinary session `404` never activates a client-only
fallback. Full snapshot fallback remains the permanent repair mechanism for retention expiry,
corruption, gaps, and future protocol changes.

Monitor bootstrap latency/size, navigation-to-render and navigation-to-ready time, resume success,
snapshot reasons, replay size, delta rows and bytes by type, client gap/protocol errors, hydration
mismatches, old-client usage, and route errors.

## Open Decisions

- Initial retention count/age and maximum catch-up message/byte limits, based on measured traffic.
- Whether non-secret externally derived annotations such as `environmentName` should remain
  best-effort or be snapshotted into SessionDO storage.
- Route-level UX for not-found versus temporarily unavailable sessions.
- Whether live-only step events should become durable timeline rows in a later consistency change.
