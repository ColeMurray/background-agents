const fs = require("fs");

let p = "features/pi-first-class/STATE-AND-HANDOVER.md";
let s = fs.readFileSync(p, "utf8");

// The gaps table: the audit's deviations.
const before = `| A personal MCP grant could name any session, so the session's authority was never consulted                  | high     | fixed: the grant is a session action, with the core's scope rule    |`;
const after = `| A personal MCP grant could name any session, so the session's authority was never consulted                  | high     | fixed: the grant is a session action, with the core's scope rule    |
| Code Mode scripts kept the model-catalog globals and the model-call tools                                  | high     | fixed: the extension is created with \`models: false\`                 |
| A Code Mode nested call whose parentage could not be proven was allowed                                    | medium   | fixed: unproven parentage is refused, not allowed                     |
| The Durable Object's context and document caches were not zeroed between turns                             | medium   | fixed: both retentions are zero                                       |
| The Pi Durable Object's storage has three independent writers                                             | medium   | open: one writer per table, through the shared adapter                |
| The projection and diff outboxes create their own tables instead of using tracked migrations               | medium   | open: move both into the migration registry with reserved ids         |
| Archive and export do not cover the Pi transcript, the task graph, or the VFS                             | medium   | open: extend the export, and preserve the Pi state on archive         |
| One \`mcp_read\` tool spans the shared lane and the personal lane                                          | low      | open: split it into two tools, one per credential domain              |
| One authority covers both prompting and the agent's lifecycle control                                    | low      | open: separate the lifecycle authority from \`collaborate\`             |`;

if (!s.includes(before)) throw new Error("gaps anchor missing");
s = s.replace(before, after);

// The commit table.
const beforeCommit = "| `HEAD~1`   | The shared MCP lane: the session resolves the core's servers and calls them with the deployment's own credential | 5,413 unit                                                      |";
const afterCommit = `| \`HEAD~1\`   | The shared MCP lane: the session resolves the core's servers and calls them with the deployment's own credential | 5,413 unit                                                      |
| \`00991358\` | Pi turns carry the session's image attachments, through the session's own authority                    | 5,422 unit                                                      |
| \`58928c92\` | The browser's execution moves behind the session that authorizes it                                    | 5,421 unit                                                      |
| \`603087fe\` | Why the browser transport uses the classic rendering endpoint                                          | —                                                               |
| \`0cdd49ea\` | The Code Mode and retention deviations the audit found                                                  | 5,430 unit, 2,475 workerd                                       |`;
if (!s.includes(beforeCommit)) throw new Error("commit anchor missing");
s = s.replace(beforeCommit, afterCommit);

// A pointer to the audit.
const beforeAudit = `### The adversarial audit rounds`;
const afterAudit = `### The integration audit

\`PI-INTEGRATION-AUDIT.md\` is the verified account of the whole integration: every component bucketed
as **A** (harness-parity), **B** (adapter/plumbing), **C** (a new primitive) or **D** (a boundary
deviation), with \`file:line\` for every claim, the deviations severity-ordered with their exploit
scenarios, the core-extension register with the single-tenant tension per item, all eighteen hazard
checks, the remaining work in dependency order, and an explicit UNVERIFIED list.
\`PI-DESIGN-CURRENT.md\` is the design derived only from that account.

Ten items are bucket **C** — a new primitive — and eight are bucket **D**. The audit corrected
several claims this document used to make, including two that were wrong: the Code Mode nested-call
fail-open was fixed against eviction but not against a parent mismatch, and the two Code Mode
model-call tools were installed and reachable, blocked only by a policy delegate that failed open.

### The adversarial audit rounds`;
if (!s.includes(beforeAudit)) throw new Error("audit anchor missing");
s = s.replace(beforeAudit, afterAudit);

fs.writeFileSync(p, s);
console.log("patched");
