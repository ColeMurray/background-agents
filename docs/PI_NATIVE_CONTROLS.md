# Pi native controls

Pi native controls are routed through the authenticated control plane and owning `SessionDO`. No
browser, bot, or public route calls `PiSessionDO` directly.

Read access exposes bounded conversation summaries, a sanitized live inspection, and the task graph.
Collaborators may submit, send, explicitly steer or follow up, fork one level, and request manual
compaction. Lifecycle-authorized users may cancel an exact submission/task or reset/handoff a
conversation. Ordinary web and Slack prompts continue through the existing SessionDO queue and never
implicitly steer.

Every mutation requires a stable request ID. SessionDO migration 64 stores the action, actor,
source, request fingerprint, target IDs, state, bounded result, and terminal timestamp. A repeated
request returns its receipt; reusing its ID for a different payload is rejected. A mutation whose
RPC response is lost becomes `indeterminate` and is never blindly replayed. Completion reconciles
cost and terminal state without copying Pi's transcript into SessionDO. Rollback keeps migration 64,
the `PI_SESSION` binding, and control status/cancellation readers.

Limits: 20,000 input characters, 4,000 compaction-instruction characters, 32 conversations, one fork
level, four active tasks/subagents, a ten-minute subagent deadline, 200 inspected
entries/submissions, 64 inspected tasks, a 15-second control response deadline, and 128 retained
terminal receipts. Inspection excludes prompts, model messages, tool arguments/results, checkpoints,
errors, and credentials.

## Same-session agents

The root Pi agent can use `list_agents`, `send_agent_message`, `get_last_message`,
`follow_up_agent`, `steer_agent`, `cancel_agent`, and `inspect_agents`. These tools call the owning
SessionDO authorization bridge and then the same PiSessionDO; they never address another session.
They are installed only for user- and Slack-started sessions; automation, GitHub, and Linear
sessions retain their existing tool policy. Children inherit the parent capability selection except
delegation and agent-messaging tools, so delegation remains depth one. The four-child, task, input,
timeout, budget, and cancellation bounds apply to tool calls and human controls alike. Each
conversation accepts at most 16 pending native messages.

The session inspector's Tasks tab lists Pi conversations, active/queued work, bounded visible last
messages, token usage, and cost. Collaborators can explicitly send, follow up, steer, fork, or
compact. Lifecycle-authorized users can reset, hand off, and cancel exact tasks. Confirmation
dialogs protect context-changing actions. The ordinary composer still queues a new turn.

In an existing Pi Slack thread, two exact text commands opt into immediate control:

- `follow up now: <message>`
- `steer: <message>`

Slack signature and actor assertions, session collaboration authority, deployment capability
discovery, and stable event-derived request IDs all apply. Every other thread message keeps the
ordinary queued-turn behavior.
