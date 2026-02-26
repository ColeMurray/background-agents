/**
 * Spawn Task Tool — creates a child coding session.
 *
 * The child inherits the parent's repository and runs independently.
 * Returns immediately with the task ID so the parent can continue working.
 */
import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { bridgeFetch, extractError } from "./_bridge-client.js"

export default tool({
  name: "spawn-task",
  description:
    "Spawn a child coding task that runs in its own sandbox. The child inherits the current repository and works independently. Returns immediately with a task ID — use get-task-status to check progress later. Use this to parallelize work: delegate sub-tasks while you continue on the main task.",
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
      .describe("Override the LLM model for the child (e.g. 'anthropic/claude-sonnet-4-6'). Defaults to the parent's model."),
  },
  async execute(args) {
    try {
      const body = { title: args.title, prompt: args.prompt }
      if (args.model) {
        body.model = args.model
      }

      const response = await bridgeFetch("/children", {
        method: "POST",
        body: JSON.stringify(body),
      })

      if (!response.ok) {
        const errorMessage = await extractError(response)

        if (response.status === 403) {
          return `Cannot spawn task: ${errorMessage}. This may be a depth limit or repository restriction.`
        }
        if (response.status === 429) {
          return `Rate limited: ${errorMessage}. Wait a moment before spawning another task.`
        }
        return `Failed to spawn task: ${errorMessage} (HTTP ${response.status})`
      }

      const result = await response.json()
      return [
        `Task spawned successfully.`,
        ``,
        `  Task ID: ${result.sessionId}`,
        `  Status:  PENDING`,
        ``,
        `Use get-task-status with this task ID to check progress.`,
      ].join("\n")
    } catch (error) {
      return `Failed to spawn task: ${error instanceof Error ? error.message : String(error)}`
    }
  },
})
