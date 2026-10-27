/**
 * Refuses tool calls the session's MCP tool allowlists deny.
 *
 * The same rules are in OpenCode's global permission config, which hides the
 * tools from the model. A repository's agent config can re-allow them, because
 * OpenCode applies an agent's permission rules after the global ones; this hook
 * runs before every tool call whatever the agent's rules say.
 *
 * OPENINSPECT_MCP_TOOL_RULES holds the rules as ordered [pattern, action] pairs
 * (see opencode_tool_access.py). As in OpenCode, the last matching rule wins. A
 * pattern is an exact tool id or a "<server>_*" prefix.
 */
const RULES = JSON.parse(process.env.OPENINSPECT_MCP_TOOL_RULES || "[]");

function matches(pattern, tool) {
  return pattern.endsWith("*") ? tool.startsWith(pattern.slice(0, -1)) : tool === pattern;
}

function decide(rules, tool) {
  let action = "allow";
  for (const [pattern, ruleAction] of rules) {
    if (matches(pattern, tool)) action = ruleAction;
  }
  return action;
}

export const McpToolGuard = async () => ({
  "tool.execute.before": async (input) => {
    if (decide(RULES, input.tool) === "deny") {
      throw new Error(`The ${input.tool} tool is not enabled for this session.`);
    }
  },
});
