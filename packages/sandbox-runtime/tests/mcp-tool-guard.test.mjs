import assert from "node:assert/strict";
import test from "node:test";

process.env.OPENINSPECT_MCP_TOOL_RULES = JSON.stringify([
  ["docs_*", "deny"],
  ["docs_search", "allow"],
  ["docs_extra_*", "deny"],
]);
const { McpToolGuard } = await import("../src/sandbox_runtime/plugins/mcp-tool-guard.js");
const hooks = await McpToolGuard();
const call = (tool) => hooks["tool.execute.before"]({ tool, sessionID: "s", callID: "c" }, {});

test("refuses tools the last matching rule denies", async () => {
  await assert.rejects(call("docs_delete"), /docs_delete tool is not enabled/);
  await assert.rejects(call("docs_extra_search"), /not enabled/);
});

test("allows selected tools and tools no rule matches", async () => {
  await call("docs_search");
  await call("bash");
  await call("docsearch");
});
