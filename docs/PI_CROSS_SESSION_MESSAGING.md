# Pi cross-session messaging

A Pi session may hand a bounded message to another Open-Inspect session. The message is never a
direct call between two agents: the owning session decides whether it may happen, and the receiving
session decides again whether it accepts it.

## The path

```text
Pi session A → SessionDO A → D1 authority → durable receipt → SessionDO B → target queue
```

1. **The source session owns the decision.** It checks its own latched capability, the live
   deployment mode, that the originating turn has a human actor, that the actor may collaborate in
   the target, and that the message chain is not too deep or too wide.
2. **D1 resolves current authority.** The target's visibility, owner, team, and collaborators are
   read at the moment of the call, never from a cache. A suspended user, a removed collaborator, or
   a lost team membership takes effect immediately.
3. **A durable receipt is written** before the target is called. One request key produces one
   receipt, so a retry delivers the same message once, and a reused key with different content is
   refused.
4. **The target revalidates everything** for itself before it enqueues anything. A receipt the
   target cannot confirm is refused rather than shown.
5. **The result returns** as a message id and a state. The source never sees the target's
   transcript.

## What the target shows

The message is authored by a machine identity, `cross-session:<source session id>`, and it carries
typed provenance. The timeline says:

> Agent message · from session `<id>` · initiated by `<user>`

The initiator is named in the provenance; they are never made a participant of the target session,
so the target's participant list, presence, and access do not change because a message arrived.

## Limits

| Limit            | Value            | Why                                         |
| ---------------- | ---------------- | ------------------------------------------- |
| Message length   | 8,000 characters | A message is a note, not a document         |
| Chain depth      | 3 hops           | Agents must not ping-pong between sessions  |
| Fan-out per turn | 5 sessions       | One turn must not reach the whole workspace |

## Configuration

| Setting                           | Default | Meaning                          |
| --------------------------------- | ------- | -------------------------------- |
| `PI_CROSS_SESSION_MESSAGING_MODE` | `off`   | Deployment gate for new sessions |

The capability is also latched per session: a session created while the mode was off keeps the
capability off, even after the deployment turns it on. A session created before this capability
existed is read with it closed.

## What is deliberately absent

- No direct Pi-to-Pi call. The source session always goes through its own owner.
- No hidden transcript. The source receives a bounded result, not the target's history.
- No escalation. An administrator who may break-glass _read_ a private session may not send into it;
  sending needs the same `collaborate` authority that posting in the target would need.
