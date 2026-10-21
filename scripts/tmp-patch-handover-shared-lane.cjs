const fs = require("fs");

let p = "features/pi-first-class/STATE-AND-HANDOVER.md";
let s = fs.readFileSync(p, "utf8");

const before = "| `HEAD~1`   | The MCP grant becomes a session action, with the core's repository scope rule                      | 5,409 unit, 2,475 workerd                                       |";
const after = `| \`HEAD~1\`   | The MCP grant becomes a session action, with the core's repository scope rule                      | 5,409 unit, 2,475 workerd                                       |
| \`HEAD~1\`   | The shared MCP lane: the session resolves the core's servers and calls them with the deployment's own credential | 5,413 unit                                                      |`;
if (!s.includes(before)) throw new Error("commit anchor missing");
s = s.replace(before, after);

const beforeTable = `| MCP read                     | Ready behind its own gate            | Grants, reviewed catalog, gateway, broker authority, the transport, the OAuth callback      |`;
const afterTable = `| MCP read                     | Ready behind its own gate            | Both lanes: the shared servers the session already scopes, and the owner's granted connections |`;
if (!s.includes(beforeTable)) throw new Error("table anchor missing");
s = s.replace(beforeTable, afterTable);

const beforeSteps = `### What is left to build for the shared lane

1. The session-side shared-server resolution: the core's resolver, plus the server's reviewed
   read-only catalog, exposed through the session's MCP roster so the model is offered only
   reviewed reads.
2. The session-owned call: the SDK client over the shared headers, bounded, audited, credential-free.
3. The Pi read tool's target: a shared server alongside a personal connection, with the same
   reviewed gate and the same bounds.
4. The live canary against a real MCP server, with a repo-scoped server and a session without that
   repo, to prove the scope rule holds.`;
const afterSteps = `### What the shared lane does now

- The session resolves the shared servers with the core's own resolver and the session's own
  repositories, so the scope is exactly the sandbox's.
- Only the server's reviewed read-only tools are listed, and only those are callable. A mutation is
  unrepresentable.
- The call belongs to the session: the MCP SDK's client over the deployment's own headers, closed
  over for one call, with the provider's error never leaving the session.
- The result is bounded and refused when it carries a credential-shaped key, exactly as the personal
  lane's result is.
- The Pi read tool names either a personal connection or a shared server, and the session's MCP
  roster lists both, so the model is offered only what it may read.

**What is left for the shared lane:** the live canary against a real MCP server, with a repo-scoped
server and a session without that repo, to prove the scope rule holds.`;
if (!s.includes(beforeSteps)) throw new Error("steps anchor missing");
s = s.replace(beforeSteps, afterSteps);

fs.writeFileSync(p, s);
console.log("patched");
