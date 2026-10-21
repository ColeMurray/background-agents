# Adversarial audit round 6 — the paths the earlier rounds did not read

Scope: the five surfaces no earlier round examined. One auditor read them against the boundary rules
and the product's own multiplayer rules, and reported eight findings: two high, four medium, two
low. This is what each one was and what changed.

The surfaces were:

- **A.** Every route the Pi Durable Object calls on the owning session, and what each one checks.
- **B.** The multiplayer invariants for a Pi session: participants, presence, typing, timeline
  ordering, read state, visibility, budget, stop, archive, delete, export, and the WebSocket.
- **C.** The fifteen Pi features the product maps onto Open-Inspect's boundaries, one by one.
- **D.** Where a Pi session's spend is charged, and what escapes it.
- **E.** The turn pipeline: exactly-once prompt reconciliation, and what an eviction does to it.

## What the audit confirmed

**The multiplayer invariants hold.** A Pi session is one Open-Inspect session: one participant (the
human owner), the same presence and typing broadcasts, the same ordered timeline, the same read
receipts and unread state, the same visibility, the same stop fence, the same archive and delete
paths, the same export, and the same WebSocket. The Pi agent is never a participant, and the Pi
Durable Object never opens a socket of its own, so there is no second transport.

**Most of the Pi features are already inside Open-Inspect's boundaries.** The durable inbox, child
conversations, the task graph, the sanitized inspection, fork, reset and handoff, compaction, and
skills are all integrated. Scheduling is correctly deferred to Open-Inspect's automation authority —
there is no Pi-native scheduler, so the automations table stays the only scheduler.

**The budget mechanism is correct.** A message's model tokens are charged exactly once, from a
per-operation baseline latched at submit, with a monotonic maximum; a resent event adds nothing and
a dropped one is repaired by the next; exhaustion stops the running Pi turn; a cost-capped session
fails closed when the model has no trusted price; and the control completion is charged exactly
once.

**The exactly-once pipeline is correct.** One model call per prompt, a CAS-guarded dispatch fence,
ambiguity resolved by lookup and never by resubmission, a stop that settles only for a proven
absence, a re-dispatch that cannot change the model, idempotent terminal results, and a sequenced,
idempotent projection.

## The findings

### 1 — a native control in flight broke the Durable Object's restart (blocking)

A native control (a steer, a follow-up, an agent message) submits to Pi with a request id that is
never an Open-Inspect message, so it has no operation metadata. On restart, the Durable Object
walked _every_ pending submission and started an event relay for it — and the relay requires
operation metadata, so it threw. The failure happened inside the startup path, so **every later
prompt on that session was refused** with "Pi Durable initialization failed", and the session's
message was marked failed rather than retried.

That is a session-killing bug, and no test reached it: the workerd tests always ran with the
capability off or with no control in flight.

The fix: the relay leaves a submission alone when it has no operation metadata. A control's
completion is recorded by the control path, not by the event relay. The regression test is in the
workerd lane, and it was checked against the unfixed code: it fails there and passes here.

### 2 — a follow-up's model spend was never charged (high)

A Pi follow-up is a native control, not a message. Its model run was charged with
`suppressCost: true` on the reasoning that a follow-up only continues the current turn and its
tokens are already inside that turn's accounting. That is true for a **steer**, which joins the
running turn. It is false for a **follow-up**: a follow-up starts its own run, and that run's tokens
belong to no message. They were never charged, so `session.total_cost` never moved, so
`budget_exhausted` never tripped, and `max_cost_usd` was unenforceable for follow-ups.

The fix charges a follow-up from **the turn it was queued behind**: the running turn's baseline plus
its own projected cost is the point where the follow-up's own spend begins, and the follow-up is
charged the spend after it. A steer is still suppressed, because it genuinely joins the running
turn. A follow-up on an idle conversation is charged from the baseline latched at submit, which is
exactly its own spend.

### 3 — the repository materialization read the whole repository with no turn behind it (medium — fixed, then corrected)

The materialization streams the session's repository through the deployment's source-control
credential, and it is the one capability read in the whole surface with no admitted operation, no
human actor, no timeline row, and no budget attribution. Its sibling in the same class — the
repository tool — requires an active operation.

The first fix required an active operation on the route, and the workerd lane proved it wrong. The
repository overlay is materialized **once per session, at setup**, before a turn exists: the session
pins its repositories when it opens, and the overlay is built then. Seven workerd tests failed
against the gate, and they were right.

So the finding is corrected rather than kept. The materialization is a **session-lifecycle read**,
not a turn read, and it is scoped by the session itself: the route refuses any commit that is not
the session's own claimed baseline, and the baseline claim refuses to move an existing one. The
_per-turn_ repository reads are operation-gated, because they go through the repository tool, which
requires an active operation. The read that is not turn-attributed is the one that happens before
there is a turn, and it reads only the session's own claimed baseline.

### 4 — the session context's pin mode claimed diff baselines with no turn behind it (medium — fixed, then corrected)

The bootstrap answer is what a session needs _before_ its first turn, so it stays ungated. The pin
mode is different: it resolves a credentialed reference and **writes** the session's diff baselines
in D1. The write was unattributed.

The first fix required an active operation on the pin mode, and the workerd lane proved it wrong for
the same reason: the pin happens at setup, when the session opens its repositories. The pin mode is
therefore ungated, like the bootstrap, and the write it makes is the session claiming its own
baseline — a write it may only make once, and never move afterwards.

### 5 — Code Mode was the only capability with no per-turn session authority (medium)

Every other capability resolves its authority inside the session, per operation: the browser, the
cross-session message, the MCP read, the native execution, the external action. Code Mode resolved
only the deployment-wide live mode, from inside the Durable Object. There was no session route, no
operation identity, no actor, no timeline row, and no audit — the execution landed in a separate
sandbox that the session never observed.

The fix adds the missing middle of the chain: a `piCodeModeAuthorize` route that requires the turn
to belong to the session, requires the turn to have a workspace actor, and checks the session's
latched capability. The run is recorded on the session's timeline with its actor, so a collaborator
can see that Code Mode ran.

### 6 — a busy conversation was reported as an unknown outcome (medium)

Pi refuses a control on a busy conversation with `ConversationBusy`. The handler's list of
_deterministic_ refusals did not mention "busy", so a refusal the caller could act on immediately
was reported as **indeterminate**: a 503 instead of a 400, and a receipt that stayed in the
session's authority table as an active operation forever.

The fix: a busy conversation is a refusal, not an unknown outcome.

### 7 — the MCP grant list was not tied to a turn (low)

The read required an operation id and a human actor; the list of the session's own grants required
neither. The fix names the turn, as the read does.

### 8 — an event could be projected for an operation whose dispatch was ambiguous (low)

The dispatch row is created before the submit, so a row existing meant "dispatch attempted", not
"admitted". The fix refuses projections for an ambiguous dispatch.

The pre-admit window is deliberately still accepted: the first events of a turn can arrive before
the session has moved the operation to "admitted", and refusing them would break the projection of
every turn. A settled operation is still accepted, because a late projection for a known old
operation is the recovery path.

## The lanes

| Lane                    | Result                   |
| ----------------------- | ------------------------ |
| control-plane unit      | 5,409 passed (338 files) |
| workerd integration     | 2,474 passed (174 files) |
| web                     | 2,578 passed             |
| shared                  | 1,314 passed             |
| Terraform               | 113 passed               |
| workflow contracts      | 13 passed                |
| lint, format, typecheck | clean                    |

## What the audit says is _not_ implemented

These are gaps, correctly documented, and none of them is a boundary violation:

- **Pi memory tools.** The contract exists for the sandbox harnesses; the Pi surface has none.
- **MCP resources and prompts.** The MCP surface is read-only _tools_.
- **MCP elicitation.** No handler, route, or schema.
- **Image attachments.** Fail-closed with a clear error, not silently dropped.
- **Follow-up-now.** Pi has no interrupt-and-continue primitive; a follow-up queues behind the
  current turn.

Each is listed as future work in the plan, and each is refused rather than half-built.
