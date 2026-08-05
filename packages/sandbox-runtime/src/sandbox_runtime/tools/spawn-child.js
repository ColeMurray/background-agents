/**
 * Spawn Child Tool — creates a child coding session.
 *
 * The child inherits the parent's repository and runs independently.
 * Returns immediately with the child ID so the parent can continue working.
 */
import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import { bridgeFetch, extractError } from "./_bridge-client.js";

export default tool({
  name: "spawn-child",
  description:
    "Spawn a child coding session in a separate sandbox. Invoke only when the user's current request explicitly asks for a 'child session' or 'child sessions'. Do not treat 'sub-agent', 'subagent', 'sub-task', or 'subtask' as requests for child sessions; those terms refer to in-process task delegation. Otherwise work directly. Never infer permission or suggest using a child session. The child inherits the repository, not conversation context, and continues running after the parent responds. Returns a child ID; check status only when its result is needed.",
  args: {
    title: z.string().describe("Short title describing the child session (shown in the UI)."),
    prompt: z
      .string()
      .describe(
        "Detailed instructions for the child agent. Be specific — the child has no context beyond what you provide here."
      ),
    model: z
      .string()
      .optional()
      .describe(
        "Override the LLM model for the child. Must use 'provider/model' format (e.g. 'anthropic/claude-sonnet-4-6', 'openai/gpt-5.4'). Defaults to the parent's model."
      ),
    reasoning: z
      .string()
      .optional()
      .describe(
        "Overrides the reasoning effort for the child. Defaults to the parent's reasoning effort."
      ),
  },
  async execute(args) {
    try {
      const body = { title: args.title, prompt: args.prompt };
      if (args.model) {
        body.model = args.model;
      }
      if (args.reasoning !== undefined) {
        body.reasoningEffort = args.reasoning;
      }

      const response = await bridgeFetch("/children", {
        method: "POST",
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorMessage = await extractError(response);

        if (response.status === 403) {
          return `Cannot spawn child: ${errorMessage}. This may be a depth limit or repository restriction.`;
        }
        if (response.status === 429) {
          return `Rate limited: ${errorMessage}. Wait a moment before spawning another child.`;
        }
        return `Failed to spawn child: ${errorMessage} (HTTP ${response.status})`;
      }

      const result = await response.json();
      return [
        `Child spawned successfully.`,
        ``,
        `  Child ID: ${result.sessionId}`,
        `  Status:  PENDING`,
        ``,
        `The child will continue independently. Check status only when you need its result; do not poll repeatedly.`,
      ].join("\n");
    } catch (error) {
      return `Failed to spawn child: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});
