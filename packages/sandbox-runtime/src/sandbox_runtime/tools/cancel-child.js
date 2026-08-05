/**
 * Cancel Child Tool — cancel a running child session.
 */
import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import { bridgeFetch, extractError } from "./_bridge-client.js";

export default tool({
  name: "cancel-child",
  description:
    "Cancel a running child session only when the user requests it or the work is clearly obsolete. Do not cancel because a child is slow, the parent is finished, or as cleanup. Nested children are cancelled by default. The child's sandbox will be stopped and its status set to cancelled.",
  args: {
    childId: z.string().describe("The child ID to cancel (from spawn-child or get-child-status)."),
    cancelNested: z
      .boolean()
      .default(true)
      .describe("Whether to also cancel all nested child sessions. Defaults to true."),
  },
  async execute(args) {
    try {
      const encodedChildId = encodeURIComponent(args.childId);
      const response = await bridgeFetch(`/children/${encodedChildId}/cancel`, {
        method: "POST",
        body: JSON.stringify({ cancelNested: args.cancelNested }),
      });

      if (!response.ok) {
        if (response.status === 404) {
          return `Child "${args.childId}" not found. Use get-child-status to list available children.`;
        }
        if (response.status === 409) {
          const errorMessage = await extractError(response);
          return `Cannot cancel: ${errorMessage}`;
        }
        const errorMessage = await extractError(response);
        return `Failed to cancel child: ${errorMessage} (HTTP ${response.status})`;
      }

      const result = await response.json();
      const nestedCount = Array.isArray(result.cancelledDescendantIds)
        ? result.cancelledDescendantIds.length
        : 0;
      const nestedNote =
        nestedCount > 0 ? ` Also cancelled ${nestedCount} nested child session(s).` : "";
      return `Child "${args.childId}" cancelled successfully.${nestedNote} Status: ${(result.status || "cancelled").toUpperCase()}`;
    } catch (error) {
      return `Failed to cancel child: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});
