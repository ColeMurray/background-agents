/**
 * Spawn Task Tool — creates a child coding session.
 *
 * The child inherits the parent's repository and runs independently.
 * Returns immediately with the task ID so the parent can continue working.
 */
import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import { bridgeFetch, extractError } from "./_bridge-client.js";

export default tool({
  name: "spawn-task",
  description:
    "Spawn a child coding task in a separate sandbox. You MUST NOT invoke this tool unless the user's current request explicitly asks for a 'child session' or 'child sessions'. Work directly in all other cases, even when the work is substantial, self-contained, parallelizable, or has multiple parts. Never infer permission from task complexity or potential speed improvements, and do not suggest or ask to use a child session when the user did not request one. The child inherits the repository, not conversation context, and continues running after the parent responds. Returns a task ID; continue other work and check status only when the result is needed.",
  args: {
    title: z.string().describe("Short title describing the child task (shown in the UI)."),
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
  },
  async execute(args) {
    try {
      const body = { title: args.title, prompt: args.prompt };
      if (args.model) {
        body.model = args.model;
      }

      const response = await bridgeFetch("/children", {
        method: "POST",
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorMessage = await extractError(response);

        if (response.status === 403) {
          return `Cannot spawn task: ${errorMessage}. This may be a depth limit or repository restriction.`;
        }
        if (response.status === 429) {
          return `Rate limited: ${errorMessage}. Wait a moment before spawning another task.`;
        }
        return `Failed to spawn task: ${errorMessage} (HTTP ${response.status})`;
      }

      const result = await response.json();
      return [
        `Task spawned successfully.`,
        ``,
        `  Task ID: ${result.sessionId}`,
        `  Status:  PENDING`,
        ``,
        `The task will continue independently. Check status only when you need its result; do not poll repeatedly.`,
      ].join("\n");
    } catch (error) {
      return `Failed to spawn task: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});
