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
    "Spawn a child coding task that runs in its own sandbox. The child inherits the current repository and works independently after the parent responds. Returns immediately with a task ID. Use this to parallelize substantial self-contained work, then check status only when its result is needed.",
  args: {
    title: z.string().describe("Short title describing the child task (shown in the UI)."),
    prompt: z
      .string()
      .describe(
        "Detailed instructions for the child agent. Be specific — the child has no context beyond what you provide here."
      ),
  },
  async execute(args) {
    try {
      const body = { title: args.title, prompt: args.prompt };

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
