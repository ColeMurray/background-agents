const fs = require("fs");

// The round 6 record corrects the two findings whose fix was wrong.
let p = "features/pi-first-class/AUDIT-ROUND-6.md";
let s = fs.readFileSync(p, "utf8");

const before = `### 3 — the repository materialization read the whole repository with no turn behind it (medium)

The materialization streams the session's repository through the deployment's source-control
credential, and it was the one capability read in the whole surface with no admitted operation, no
human actor, no timeline row, and no budget attribution. Its sibling in the same class — the
repository tool — requires an active operation.

The fix: the route requires an active operation, and the Durable Object names the turn behind every
part of the materialization. The read is already visible on the timeline, because it is a
repository tool call's own work.

### 4 — the session context's pin mode claimed diff baselines with no turn behind it (medium)

The bootstrap answer is what a session needs *before* its first turn, so it stays ungated. The pin
mode is different: it resolves a credentialed reference and **writes** the session's diff baselines
in D1. The write was unattributed.

The fix: the pin mode requires an active operation, and the Durable Object names the turn.`;

const after = `### 3 — the repository materialization read the whole repository with no turn behind it (medium — fixed, then corrected)

The materialization streams the session's repository through the deployment's source-control
credential, and it is the one capability read in the whole surface with no admitted operation, no
human actor, no timeline row, and no budget attribution. Its sibling in the same class — the
repository tool — requires an active operation.

The first fix required an active operation on the route, and the workerd lane proved it wrong.
The repository overlay is materialized **once per session, at setup**, before a turn exists: the
session pins its repositories when it opens, and the overlay is built then. Seven workerd tests
failed against the gate, and they were right.

So the fix is corrected rather than kept. The materialization is a **session-lifecycle read**, not a
turn read, and it is scoped by the session itself: the route refuses any commit that is not the
session's own claimed baseline, and the baseline claim refuses to move an existing one. The
*per-turn* repository reads are operation-gated, because they go through the repository tool, which
requires an active operation. The read that is not turn-attributed is the one that happens before
there is a turn, and it reads only the session's own claimed baseline.

### 4 — the session context's pin mode claimed diff baselines with no turn behind it (medium — fixed, then corrected)

The bootstrap answer is what a session needs *before* its first turn, so it stays ungated. The pin
mode is different: it resolves a credentialed reference and **writes** the session's diff baselines
in D1. The write was unattributed.

The first fix required an active operation on the pin mode, and the workerd lane proved it wrong
for the same reason: the pin happens at setup, when the session opens its repositories. The pin mode
is therefore ungated, like the bootstrap, and the write it makes is the session claiming its own
baseline — a write it may only make once, and never move afterwards.`;

if (!s.includes(before)) throw new Error("round 6 anchor missing");
s = s.replace(before, after);
fs.writeFileSync(p, s);

// The handover records the correction.
p = "features/pi-first-class/STATE-AND-HANDOVER.md";
s = fs.readFileSync(p, "utf8");
const beforeGaps = `| The repository materialization read the whole repository with no turn behind it                  | medium   | fixed: it needs an active operation                                  |
| The session context's pin mode claimed diff baselines with no turn behind it                    | medium   | fixed: the pin mode needs an active operation                        |`;
const afterGaps = `| The repository materialization read the whole repository with no turn behind it                  | medium   | corrected: it is a session-lifecycle read; the turn reads are gated     |
| The session context's pin mode claimed diff baselines with no turn behind it                    | medium   | corrected: the pin happens at setup, and claims the baseline once      |`;
if (!s.includes(beforeGaps)) throw new Error("handover gaps anchor missing");
s = s.replace(beforeGaps, afterGaps);
fs.writeFileSync(p, s);

console.log("patched");
