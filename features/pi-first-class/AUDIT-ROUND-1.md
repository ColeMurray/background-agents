# Adversarial audit round 1 — first-class Pi, cross-session and external action slices

Scope: the code added in `75be1a63`, `1c9ec044`, `37ef29e8`, `423fca77`.

## Question 1 — can Pi reach another session or another effect without the owner?

- The Pi Durable Object never holds a second session's stub for cross-session messaging. The
  `message_session` tool calls the _owning_ session's internal route; the owning session is the only
  thing that decides anything.
- The provider executor closes over a credential and is only reachable through the SessionDO
  gateway. The Pi side never sees a credential, a provider URL with a token, or a raw provider
  response.
- The external action policy hook is the only path from a model call to a provider write, and it
  always goes through a SessionDO-prepared action.

## Question 2 — can a collaborator without authority approve or send?

- Approving an external effect needs `collaborate` on the session plus the
  `external_actions.approve` permission. The route-admission sentinel proves a same-team viewer is
  refused at the session layer.
- Sending into another session needs the same `collaborate` authority _on the target_, resolved from
  current D1 state. An administrator with break-glass read on a private session is refused for
  `collaborate`, because the canonical resolver only permits read for break-glass.

## Question 3 — can one effect happen twice?

- The external action ledger coalesces an identical nonterminal effect into one entry, scoped to one
  session.
- The provider write carries a marker derived from the action id, and reconciliation looks for that
  marker before anything is written again.
- The cross-session receipt is written before the target is called, and one request key produces one
  receipt.

## Question 4 — what can a failure leak?

- Public external-action errors are mapped to a bounded code and message. The provider's own string
  never reaches the browser.
- The provider executor keeps the credential in the request headers only. A result, an error, and a
  rejection reason never contain it; the conformance suite asserts this for every provider.

## Question 5 — what happens when the deployment turns a capability off?

- The live mode is read per request. A denied deployment blocks new prepares and new approvals while
  status, audit recovery, reconciliation, denial, and cancellation stay available.
- Cross-session messaging needs both the session's latched capability and the live deployment mode.
  An older session snapshot is read with the new feature closed.

## Question 6 — does any of this change how Open-Inspect behaves for other harnesses?

- Every new route is capability-gated and defaults off.
- The message table gains an optional provenance column that is null for every message that did not
  come from elsewhere.
- The capability snapshot grew a version. A version 1 snapshot is read as version 2 with the new
  feature closed.

## Findings that were fixed during this round

1. Effect coalescing was not scoped to a session, so two sessions could share one effect. The scope
   is now part of the lookup, and the regression is covered by a test.
2. A provider request could hang forever. The executor now races the request against its own
   deadline, so a hung provider becomes an indeterminate outcome that is reconciled instead of a
   request that never ends.
3. The marker comparison compared a body against an action id. The marker is now extracted on both
   sides.
4. The executions BFF read `request.nextUrl`, which a plain `Request` does not have. It now reads
   the query from the URL.
