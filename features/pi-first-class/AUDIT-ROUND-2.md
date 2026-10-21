# Adversarial audit round 2 — the multiplayer contract

Scope: the same changes, reviewed against the rule that Pi must not change how Open-Inspect behaves
for the people in a session.

## The invariant under review

> Pi collaborators keep the same participants, presence, typing, read state, shared timeline,
> message order, visibility, budget, stop, archive, delete, and export. Pi child conversations and
> cross-session activity are subordinate activity inside one Open-Inspect session. They do not
> become separate multiplayer rooms.

## What was checked

### The target session's participant list

A cross-session message has to be authored by something. The first implementation authored it by the
human who initiated it, which meant the target session grew a participant row for a person who may
only be a collaborator. A collaborator row is an access grant; a participant row is display. Making
a message's initiator appear in the target's participant list would change the list for a message
that arrived from somewhere else, and it would imply a presence that nobody has.

The message is now authored by a machine identity, `cross-session:<source session id>`, and the
human who initiated it is named in the provenance. Access is unchanged, because a participant row is
never an access grant: the access rules read `session_collaborators`, the owner, and the team, never
`participants`.

### The target session's access

The target re-resolves the initiator's authority for itself, at delivery time, against current D1
state. It does not trust the source's decision, and it does not trust its own cached view. An
administrator who may break-glass read a private session is refused, because the canonical resolver
permits read only for break-glass and the message needs `collaborate`.

### Message ordering, presence, and typing

The message is enqueued through the target's own queue, so it takes its place in the target's order
and it is delivered by the target's own worker. Nothing writes a timeline row in another session
directly.

### Budget and cost

The target's own queue applies the target's budget and capacity checks. A message that the target
cannot afford is refused by the target, and the source records the refusal on its receipt. The
source's budget is untouched by the delivery, and the target's budget is untouched by the attempt.

### Visibility

The target is a different session with its own visibility rules. The target's collaborators see the
message; nobody else does. The source session does not receive the target's transcript, and the
result path returns only the message id and the state.

### Other harnesses

Nothing in the cross-session path changes OpenCode, Claude Agent, or Codex. The tool is contributed
by a Pi-only extension behind a Pi-only capability, and the message table's new provenance column is
null for every message that did not come from elsewhere.

## Findings that were fixed during this round

1. The cross-session message was authored by the initiating human, which added that human to the
   target's participant list. It is now authored by a machine identity, and the human is named in
   the provenance.
2. The fan-out and depth limits were defined but not enforced. Both are now counted from durable
   state, and the receipt records the operation that produced it.
