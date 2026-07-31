# Per-User Session Unread Indicators

## Status

- Date: 2026-07-31
- Status: Proposed design
- Baseline: `public/main` at `93a83361`
- Scope: Unread state in authenticated web session navigation
- Related:
  - [Session Identity Consolidation](2026-07-29-session-identity-consolidation-plan.md)
  - [Session Sidebar Started By Filter](2026-05-17-session-sidebar-started-by-filter-spec.md)
  - [Public Fork Implementation Research](2026-07-30-public-fork-implementation-research.md)

## 1. Decision

Open Inspect should add per-user unread indicators using a server-owned cursor:

```text
session's latest terminal message ID
                 compared with
user's acknowledged message ID for that session
                 equals
read or unread for that user
```

The existing terminal `messageId` is the cursor. Open Inspect already gives each prompt message a
stable ID and persists its `execution_complete` event idempotently as
`execution_complete:<messageId>`. The unread feature does not need a second event ledger, generated
sequence, notification object, or per-session user state inside Durable Objects.

The first version includes:

- automatic unread state when a background agent turn reaches a visible terminal outcome;
- automatic acknowledgement after the latest outcome is actually visible in the active browser tab;
- explicit **Mark as read**;
- server-persisted state that follows a canonical user across tabs and devices.

The first version defers:

- **Mark as unread**;
- unread descendant aggregation on parent sessions;
- unread counts and filtering;
- external notifications and a notification center.

These deferments keep the first release focused on the core user problem without introducing
reminder semantics, recursive tree queries, or another delivery system.

## 2. Problem

Open Inspect runs work in the background. Status and last-updated time show what a session is doing,
but they do not answer:

> Which sessions have produced agent results that I have not reviewed?

A shared boolean is incorrect because one person's review would clear everyone else's indicator.
Browser-local state is also insufficient because it does not follow the user across devices and can
leak between users on a shared browser.

The design must isolate users, tolerate multiple tabs and terminal-event retries, reject stale
acknowledgements, and avoid treating off-screen or background content as read.

## 3. Product Semantics

### 3.1 What creates unread state

One accepted terminal agent turn creates one attention-worthy outcome:

- successful completion;
- failed completion;
- user-requested stop with a persisted terminal result;
- execution timeout with a persisted terminal result.

The terminal message's stable `messageId` identifies that outcome.

Streaming tokens, tool calls, prompt submission, title changes, status changes, artifacts, cost
updates, and user-authored messages do not independently create unread state.

### 3.2 What counts as read

Opening `/session/:id` is not enough. The browser automatically acknowledges an outcome only after:

1. the relevant timeline history is loaded;
2. the latest terminal outcome's rendered content is visible;
3. the route and browser tab are active and foregrounded.

The acknowledgement names the exact `messageId` the browser rendered. Viewport implementation and
dwell-time tuning belong in the implementation plan; the product invariant is that off-screen or
background content is not acknowledged.

### 3.3 Explicit Mark as read

**Mark as read** snapshots the session's current latest terminal message on the server and stores it
as acknowledged for the requesting user. It does not affect future outcomes or another user's state.

### 3.4 Lifecycle

Archiving preserves read state; restoring restores it. Deleting a session or user cascades its
per-user rows. Existing sessions do not become unread at rollout because historical attention is not
backfilled.

### 3.5 New users

In the current single-tenant model, `users.created_at` is the earliest time a canonical user could
have navigated the shared application. Outcomes older than that timestamp are not unread for that
user. If Open Inspect later adds tenant membership or per-session grants, the visibility-start time
replaces account creation for this baseline.

## 4. Architecture

| Concern                               | Owner                                |
| ------------------------------------- | ------------------------------------ |
| Terminal outcome                      | Session Durable Object               |
| Latest outcome and per-user cursor    | D1 session index                     |
| Viewer identity and visibility        | Authenticated control-plane boundary |
| Visible-content acknowledgement       | Web session page                     |
| Indicator rendering and cache updates | Web navigation layer                 |

Session Durable Object remains authoritative for detailed history. D1 is the existing cross-session
navigation index and owns cross-device user read state. The browser cache is never authoritative.

Per-user state must not live in each Session Durable Object. Global listing would otherwise require
one object read per session and distribute one user's navigation preferences across many databases.

## 5. Data Model

### 5.1 Session projection

Add these fields to D1 `sessions`:

```sql
latest_attention_message_id         TEXT
latest_attention_message_created_at INTEGER
latest_attention_at                 INTEGER
```

The authoritative order is `(messages.created_at, messages.id)`, compared lexicographically. The
message queue must use the same `ORDER BY created_at ASC, id ASC` tie-breaker when selecting pending
messages. D1 replaces the latest projection only when the incoming tuple is greater. This prevents a
delayed older completion from replacing a newer one.

`latest_attention_at` is control-plane acceptance time, not a sandbox-supplied timestamp. It is used
only for the new-user baseline.

No historical data is backfilled. `latest_attention_message_id IS NULL` means the session has no
post-rollout attention-worthy outcome.

### 5.2 Per-user state

```sql
CREATE TABLE session_read_states (
  user_id                           TEXT NOT NULL,
  session_id                        TEXT NOT NULL,
  acknowledged_attention_message_id TEXT,
  updated_at                        INTEGER NOT NULL,
  PRIMARY KEY (user_id, session_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX idx_session_read_states_session
  ON session_read_states(session_id, user_id);
```

Rows are sparse. A missing row means the user has not acknowledged a post-rollout outcome.

For the authenticated user:

```text
unread =
  latest_attention_message_id is not null
  AND latest_attention_at >= users.created_at
  AND (
    acknowledged_attention_message_id is null
    OR acknowledged_attention_message_id != latest_attention_message_id
  )
```

The comparison is by stable identity, not wall-clock time. The timestamp only establishes the
new-user baseline.

When a new message becomes latest, users whose cursor points elsewhere see unread without fan-out
writes. D1 needs no attention history because the Session Durable Object already owns it.

## 6. Recording Terminal Outcomes

After persisting a terminal message, all real, stopped, and timed-out completion paths call one
`recordLatestAttention(sessionId, messageId, messageCreatedAt, acceptedAt)` domain operation.

The operation updates the D1 projection only when the supplied terminal-message order is newer.
Repeating the same `messageId` is idempotent. A duplicate sandbox event that does not transition a
message to terminal must not create a new logical outcome.

Projection failure must not corrupt the terminal message. Use one awaited attempt and one bounded,
idempotent retry; v1 adds no feature-specific queue, outbox, or alarm.

## 7. Identity and Authorization

The read-state key is the authenticated principal's canonical D1 `users.id`:

```text
ctx.principal.kind === "user"
ctx.principal.userId = session_read_states.user_id
```

SessionDO `participants.id` remains session-local membership and authorship identity. Provider user
IDs, login, email, profile fields, and participant IDs are not valid cross-session preference keys.

The browser never sends an identity override. The BFF authenticates the browser and
`controlPlaneUserFetch` preserves the control plane as the trusted identity boundary.

Read-state access uses the same visibility decision as opening or listing the session. The current
deployment is single-tenant, but the route should call a shared visibility boundary rather than
hard-code ownership. A session that is nonexistent or not visible returns the same `404`. Service
and sandbox principals cannot read or mutate human viewer state.

Viewer-specific responses use `Cache-Control: private, no-store`.

## 8. API Contract

### 8.1 Session list

User-authenticated session-list rows add an optional named object:

```ts
interface SessionNavigationState {
  unread: boolean;
}

interface Session {
  // existing fields
  navigation?: SessionNavigationState;
}
```

The list handler derives the user ID from the principal and decorates the complete page in one
grouped D1 query. There is no query or Durable Object request per session. Non-user service callers
may omit `navigation` during mixed deployments.

### 8.2 Mutation

```http
PATCH /sessions/:id/read-state
Content-Type: application/json
```

Accepted bodies are `{ "action": "acknowledge", "observedAttentionId": "message-id" }` and
`{ "action": "mark_read" }`.

Response:

```json
{
  "sessionId": "session-id",
  "accepted": true,
  "unread": false
}
```

Rules:

- `acknowledge` succeeds only when `observedAttentionId` equals the server's current latest ID;
- a stale or not-yet-projected acknowledgement is an idempotent no-op with `accepted: false`;
- `mark_read` snapshots the server's current latest ID;
- repeating either action is idempotent;
- a session without a terminal outcome remains read;
- the browser never sends a desired `unread` boolean;
- every response returns canonical current `unread` state.

No separate viewer-state GET is required. The session timeline already carries terminal `messageId`,
and the server validates it against the D1 projection during acknowledgement.

## 9. Web Behavior

### 9.1 Sidebar

Unread session rows show:

- a small accent dot;
- slightly stronger title weight;
- an accessible “Unread” label.

The current session highlight, session status, and PR state keep their existing meanings. In v1,
each row reflects only its own state. Child rows are already visible in the current expanded session
tree; parent roll-up can be designed if the tree later becomes collapsible.

The row action menu offers **Mark as read** only when the row is unread.

### 9.2 Session page

The session page acknowledges the latest rendered terminal message only after its output is visible
in the active tab. Every response supplies canonical `unread` for cache reconciliation, but the
client considers the cursor acknowledged only when `accepted` is true.

Terminal output may render before its D1 navigation projection is visible. If acknowledgement
returns `accepted: false` and that same output remains visible, the page retries after session-list
revalidation or polling observes updated state. It must not permanently deduplicate the rejected
attempt.

### 9.3 Refresh behavior

V1 uses two convergence mechanisms:

1. canonical mutation responses for immediate local cache updates;
2. existing focus revalidation plus one bounded visible-tab session-list poll so completions in
   background sessions appear without opening them.

The exact polling interval is an implementation and load-test choice. `BroadcastChannel`, a global
activity WebSocket, and a notification fan-out service are deferred until measured latency or load
requires one.

## 10. Correctness Invariants

| Condition                                     | Required result                                                        |
| --------------------------------------------- | ---------------------------------------------------------------------- |
| Browser acknowledges A after B becomes latest | `accepted: false`; B remains unread                                    |
| Browser acknowledges A before A is projected  | `accepted: false`; retry when projection catches up                    |
| Terminal event is retried                     | Same message ID; no second logical outcome                             |
| Older terminal event arrives late             | Projection retains the newer outcome                                   |
| Two users view one session                    | Separate cursors                                                       |
| Several tabs share one user                   | Server cursor converges them; a stale tab cannot clear new output      |
| D1 projection fails                           | Session history remains valid; bounded retry may restore the indicator |

## 11. Performance and Observability

Session-list decoration is one indexed batch query with no per-row Durable Object reads. Each
acknowledgement writes at most one sparse row, and read state does not change session ordering.
Verify the 50-row query plan and list latency before enabling.

Track projection failures, read mutations, decoration latency, and automatic-acknowledgement
failures.

Logs must not contain prompt text, terminal output, credentials, or another user's read history.

## 12. Rollout

1. **Storage and backend:** deploy the additive D1 migration, terminal-outcome projection, and
   viewer-scoped list/mutation API. Existing rows remain read because the latest cursor is null.
2. **Web UI:** deploy indicators, visible-content acknowledgement, explicit **Mark as read**, and
   bounded refresh behavior.
3. **Enable and observe:** verify two-user behavior, stale acknowledgements, duplicate events, and
   list-query latency before general enablement.

Mixed deployments are safe because navigation fields are optional and existing clients ignore them.
Rollback disables recording and UI; additive tables and columns remain.

## 13. Required Validation

1. Two users receive independent state for the same terminal outcome.
2. A missing read-state row is unread once an eligible latest outcome exists.
3. Acknowledging message A cannot clear newer message B.
4. An acknowledgement sent before projection catches up is retried while the same output is visible.
5. Duplicate or delayed terminal events cannot create or replace the latest logical outcome.
6. Successful, failed, stopped, and timed-out paths project attention.
7. Only visible output in the active tab is acknowledged.
8. Caller-selected identities and non-user principals cannot mutate state.
9. User/session deletion cascades read rows.
10. Pre-rollout and pre-account outcomes remain read.
11. Read mutations do not reorder sessions.
12. A 50-row list uses indexed batch decoration rather than N+1 reads.

Tests that depend on real D1 constraints, foreign keys, or query behavior must run in the existing
workerd/D1 integration suite.

## 14. Alternatives and Deferred Features

| Option                                     | Decision | Reason                                                                |
| ------------------------------------------ | -------- | --------------------------------------------------------------------- |
| Shared or per-user boolean                 | Reject   | Does not identify which outcome was reviewed                          |
| Compare `updated_at` with `last_viewed_at` | Reject   | Metadata changes and clock races create false state                   |
| Browser local storage                      | Reject   | Not cross-device or safely user-scoped                                |
| Per-user state in SessionDO                | Reject   | Makes global listing an N+1 distributed read                          |
| Separate attention-event ledger            | Reject   | Duplicates history already identified by terminal `messageId`         |
| **Mark as unread**                         | Defer    | Adds reminder and multi-tab semantics beyond the core need            |
| Parent descendant roll-up                  | Defer    | Current child rows are expanded; recursive aggregation is unnecessary |
| Global activity WebSocket                  | Defer    | Focus refresh and bounded polling are sufficient for v1               |

If **Mark as unread** is later requested, it should be specified as an explicit product behavior
rather than hidden inside the read cursor. If session trees become collapsible, descendant roll-up
should begin with a server-derived boolean, not an exact count.

## 15. Fork Reference and Independent Design

The opportunity was observed in
[`mauricedesaxe/background-agents@917ef9f`](https://github.com/mauricedesaxe/background-agents/commit/917ef9fe386b45d5bf582921ad04989535607049).
That implementation is evidence of the user problem, not the target architecture or an approved code
source.

This design independently keeps the useful message-cursor pattern while changing the safety and
scope:

- automatic acknowledgement names the exact rendered `messageId`;
- stale acknowledgement is a no-op rather than “mark whatever is current as read”;
- no manual-unread override or duplicate attention ledger is added;
- no parent state is inferred from a partial client tree;
- canonical identity, authorization, two-user isolation, viewport behavior, and rollout
  compatibility are explicit requirements;
- no fork code is proposed for copying or mainlining.
