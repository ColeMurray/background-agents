# Pi external actions

A Pi session may propose an external effect — a comment on an issue, a reply in a thread. Nothing is
published until a person with the right authority approves it, and the approval is a durable record
rather than a button press.

## The path

```text
Pi task → SessionDO prepare → approval ledger → approver → SessionDO execute → provider → result
```

1. **The policy hook is mandatory.** A model call that would publish must first obtain a SessionDO
   action document. Without one, the call is blocked.
2. **One effect is one ledger entry.** An identical effect that is still pending, running, or
   indeterminate joins the existing entry. It never becomes a second approval card or a second
   provider write.
3. **The approver needs action authority.** Approving needs `collaborate` on the session plus the
   `external_actions.approve` permission. Reading a session is not enough: a private break-glass
   reader and a workspace administrator without current owning-team membership are both refused.
4. **The receipt records who decided.** The audit event carries the decision time, not the time the
   projection was flushed, and a decision the system made on its own is attributed to a service
   rather than to a user.
5. **The provider write is reconcilable.** Every publication carries a marker derived from the
   action id, so a response that is lost is reconciled by finding that marker rather than by
   publishing again.

## Approval surfaces

- `GET /sessions/:id/external-actions` lists the pending effects of a session, oldest first, with an
  opaque cursor.
- `POST /sessions/:id/external-actions/:actionId/decision` accepts `approve`, `deny`, and `cancel`.
- The session sidebar renders the pending effects with named approve, deny, and cancel controls. The
  browser never decides what it may approve; the server does.

## Expiry and cancellation

A pending approval expires after a bounded window and is cancelled by the alarm, so a request nobody
acted on cannot be published a day later after the conversation has moved on. Cancellation is
separate from denial: it is the response to an effect that is no longer wanted, including one that
was already approved but has not been dispatched. An effect the provider may already have applied
cannot be cancelled; that case must be reconciled.

## Automation grants

An automation may hold an unattended grant for one provider and one action. A grant always runs as
the automation's own executor, never as a different user. Grant administration requires the
automation's manage authority _and_ the `external_actions.manage_grants` permission, and revocation
is scoped to the automation that owns the grant.

## Providers

Four provider definitions exist: GitHub comment, GitLab comment, Slack thread reply, and Linear
comment. Each one closes over its credential, keeps it out of every result and every error, and
passes the same generic fault-injection conformance suite: a refusal stays a refusal, an unknown
stays unknown, a hung provider becomes an indeterminate failure instead of a request that never
ends, and a malformed answer never leaks.

`scripts/canary-pi-external-actions.sh` runs that suite and prints the configuration a live canary
would need. It never calls a provider.

## Configuration

| Setting                    | Default | Meaning                          |
| -------------------------- | ------- | -------------------------------- |
| `PI_EXTERNAL_ACTIONS_MODE` | `off`   | Deployment gate for new sessions |

The capability is latched per session, and a live deployment deny blocks a new prepare or a new
approval while status, audit recovery, reconciliation, denial, and cancellation stay available. An
emergency never strands admitted work.
