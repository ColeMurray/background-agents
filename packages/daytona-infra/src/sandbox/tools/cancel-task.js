/**
 * Cancel Task Tool — cancel a running child session.
 */
import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { bridgeFetch, extractError } from "./_bridge-client.js"

export default tool({
  name: "cancel-task",
  description:
    "Cancel a running child task. The task's sandbox will be stopped and its status set to cancelled. Use get-task-status to find the task ID.",
  args: {
    taskId: z.string().describe("The task ID to cancel (from spawn-task or get-task-status)."),
  },
  async execute(args) {
    try {
      const response = await bridgeFetch(`/children/${args.taskId}/cancel`, {
        method: "POST",
      })

      if (!response.ok) {
        if (response.status === 404) {
          return `Task "${args.taskId}" not found. Use get-task-status to list available tasks.`
        }
        if (response.status === 409) {
          const errorMessage = await extractError(response)
          return `Cannot cancel: ${errorMessage}`
        }
        const errorMessage = await extractError(response)
        return `Failed to cancel task: ${errorMessage} (HTTP ${response.status})`
      }

      const result = await response.json()
      return `Task "${args.taskId}" cancelled successfully. Status: ${(result.status || "cancelled").toUpperCase()}`
    } catch (error) {
      return `Failed to cancel task: ${error instanceof Error ? error.message : String(error)}`
    }
  },
})
