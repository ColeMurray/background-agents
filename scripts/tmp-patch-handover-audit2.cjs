const fs = require("fs");

let p = "features/pi-first-class/STATE-AND-HANDOVER.md";
let lines = fs.readFileSync(p, "utf8").split("\n");

// The gaps table: insert the audit's deviations after the personal-grant row.
const gapIndex = lines.findIndex((line) => line.includes("A personal MCP grant could name any session"));
if (gapIndex < 0) throw new Error("gap row not found");
const deviationRows = `| Code Mode scripts kept the model-catalog globals and the model-call tools                                   | high     | fixed: the extension is created with \`models: false\`                  |
| A Code Mode nested call whose parentage could not be proven was allowed                                         | medium   | fixed: unproven parentage is refused, not allowed                      |
| The Durable Object's context and document caches were not zeroed between turns                                  | medium   | fixed: both retentions are zero                                        |
| The Pi Durable Object's storage has three independent writers                                                  | medium   | open: one writer per table, through the shared adapter                 |
| The projection and diff outboxes create their own tables instead of using tracked migrations                    | medium   | open: move both into the migration registry with reserved ids            |
| Archive and export do not cover the Pi transcript, the task graph, or the VFS                                  | medium   | open: extend the export, and preserve the Pi state on archive            |
| One \`mcp_read\` tool spans the shared lane and the personal lane                                               | low      | open: split it into two tools, one per credential domain                 |
| One authority covers both prompting and the agent's lifecycle control                                         | low      | open: separate the lifecycle authority from \`collaborate\`                |`;
lines.splice(gapIndex + 1, 0, ...deviationRows.split("\n"));

// The commit table: insert after the shared-lane row.
const commitIndex = lines.findIndex((line) => line.includes("shared MCP lane: the session resolves"));
if (commitIndex < 0) throw new Error("commit row not found");
const commitRows = `| \`00991358\` | Pi turns carry the session's image attachments, through the session's own authority                       | 5,422 unit                                                      |
| \`58928c92\` | The browser's execution moves behind the session that authorizes it                                       | 5,421 unit                                                      |
| \`603087fe\` | Why the browser transport uses the classic rendering endpoint                                             | —                                                               |
| \`0cdd49ea\` | The Code Mode and retention deviations the audit found                                                     | 5,430 unit, 2,475 workerd                                       |`;
lines.splice(commitIndex + 1, 0, ...commitRows.split("\n"));

// The pointer to the audit.
const auditIndex = lines.findIndex((line) => line.startsWith("### The adversarial audit rounds"));
if (auditIndex < 0) throw new Error("audit heading not found");
const pointer = `### The integration audit

\`PI-INTEGRATION-AUDIT.md\` is the verified account of the whole integration: every component bucketed
as **A** (harness-parity), **B** (adapter/plumbing), **C** (a new primitive) or **D** (a boundary
deviation), with \`file:line\` for every claim, the deviations severity-ordered with their exploit
scenarios, the core-extension register with the single-tenant tension per item, all eighteen hazard
checks, the remaining work in dependency order, and an explicit UNVERIFIED list.
\`PI-DESIGN-CURRENT.md\` is the design derived only from that account.

Ten items are bucket **C** — a new primitive — and eight are bucket **D**. The audit corrected
several claims this document used to make, including two that were wrong: the Code Mode nested-call
fail-open was fixed against eviction but not against a parent mismatch, and the two Code Mode
model-call tools were installed and reachable, blocked only by a policy delegate that failed open.`;
lines.splice(auditIndex, 0, ...pointer.split("\n"));

fs.writeFileSync(p, lines.join("\n"));
console.log("patched");
