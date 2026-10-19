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
