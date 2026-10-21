const fs = require("fs");

// 1. The MCP broker's class docstring is stale: the manager IS installed on a
// Lifecycle now, and the transport is live.
let p = "packages/control-plane/src/cloudflare/mcp-connection-durable-object.ts";
let s = fs.readFileSync(p, "utf8");
const beforeDoc = `/**
 * Dormant per-connection MCP broker foundation.
 *
 * The manager deliberately is not installed on a Lifecycle yet: no persisted
 * registration is restored, no callback is accepted, and no network
 * connection or tool call can start in this slice. Installing the capability
 * is a separate live-transport canary gate. D1 remains authoritative; the
 * Agents \`cf_agents_mcp_servers\` table may later cache reconstructable
 * transport registrations only.
 */`;
const afterDoc = `/**
 * The per-connection MCP broker.
 *
 * The manager is a capability of this object's Lifecycle: the Lifecycle restores
 * the persisted connection on a cold start and serves the server's OAuth
 * callback, and the manager itself holds the credential. The transport is
 * installed but the *binding* stays disabled by default, so this object is not
 * deployed at all until an operator stages it and the canary passes.
 *
 * D1 remains authoritative: the broker re-reads the connection's owner and
 * status, and the reviewed read-only catalog, on every call.
 */`;
if (!s.includes(beforeDoc)) throw new Error("broker doc anchor missing");
s = s.replace(beforeDoc, afterDoc);
fs.writeFileSync(p, s);

// 2. The handover's claims that the audits corrected.
p = "features/pi-first-class/STATE-AND-HANDOVER.md";
s = fs.readFileSync(p, "utf8");

const beforeElicit = `### 3. MCP elicitation

The spec maps it to "SessionDO durable interaction receipt and UI". The \`agents\` SDK's client
already surfaces elicitation requests through a handler (\`MCPClientElicitationHandler\`), so the
mechanism exists; what is missing is the Open-Inspect half: a durable receipt in the session, a
route the client answers through the session, and the UI. The receipt must be durable because the
server waits for an answer that a human gives later.`;
const afterElicit = `### 3. MCP elicitation

**Bucket C — a new primitive. Three of them, and the audit says so.**

An elicitation is a **read** (the MCP result vocabulary is accept/decline/cancel), so it does
**not** belong behind the external-action approval ledger, which exists for *effects*. The ledger
cannot carry it unchanged: the producer and consumer are inverted, there is no effect to execute,
\`approve()\` takes no content, the broker has no session identity to write a session-scoped row
with, and the authority rule differs.

What a real implementation needs:

- **A durable interaction receipt** in the session (the question, the requested schema, the answer,
  the state).
- **An answer-delivery mechanism.** A receipt alone cannot work: both lanes bound every MCP call at
  30 seconds, so an in-flight human wait is impossible. The time regime has to change, or the
  protocol's out-of-band \`input_required\` shape has to be adopted.
- **An answer-authority rule**: the *connection owner* in the personal lane (that is the identity the
  provider sees), the turn's actor in the shared lane.

The \`agents\` SDK's elicitation handler is not reachable from the shared lane, which uses the raw
v2 client; and the personal lane's client lives in a broker object with no route back to the
session. There is also **no refusal reason** today: a server that elicits is indistinguishable
from any failed tool call at the session boundary.

See \`PI-MCP-ELICITATION-AUDIT.md\`.`;
if (!s.includes(beforeElicit)) throw new Error("elicitation anchor missing");
s = s.replace(beforeElicit, afterElicit);

const beforeResources = `### 2. MCP resources and prompts

The MCP SDK's client already has \`readResource\` and the prompt getter, so the *call* is easy. The
gap is the **review**: \`mcp_reviewed_tools\` covers tools only, so a resource or a prompt has no
reviewed, read-only projection to gate on. This needs a forward-only migration that records the
reviewed resources and prompts for a server revision, the same way the tool review records its
tools, and the review flow must classify them. Until that exists, a resource projection would be
ungated, which the boundary does not allow.`;
const afterResources = `### 2. MCP resources and prompts

**Bucket C — a new primitive. And the two halves are not the same.**

- **Prompts cannot be projected from the tools' review at all.** A prompt is unrelated to any tool,
  and the only rule available would be "server reviewed ⇒ prompts admitted" — which lets an external
  server write the model's instructions, a strictly higher authority than a data read, and one that
  can route the agent into a mutation. Prompts need a new table, a new effect class (the existing
  \`external_read | external_mutation\` enum cannot express "model instructions"), and an approval
  path.
- **Resources are mechanically possible without a new table**, but they replace a human act over a
  named catalog with an inference over an unbounded, server-chosen URI space (MCP resource
  templates). That is a widening of a pinned surface without a reviewer: a deviation, legitimate
  only as an explicit documented rule, and only on the shared lane — in the personal lane it would
  put the owner's OAuth credential behind a server-chosen URI.
- **The hash is the migration.** \`catalogSnapshotSha256\` hashes the reviewed *tools* only.
  Widening it invalidates every stored hash, and \`listOwned\` recomputes and throws on a mismatch —
  so this is a forward-only migration: re-review, re-stage, re-pin. The pins' stored hashes are
  compared only at grant time, so existing pins keep working while naming a hash that no longer
  describes the catalog.

See \`PI-MCP-RESOURCES-AUDIT.md\`.`;
if (!s.includes(beforeResources)) throw new Error("resources anchor missing");
s = s.replace(beforeResources, afterResources);

fs.writeFileSync(p, s);

console.log("patched");
