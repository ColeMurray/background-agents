import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import { bridgeFetch } from "./_bridge-client.js";
import { waitForChildren } from "./_wait-for-children.js";

export default tool({
  name: "wait-for-children",
  description:
    "Wait for specific direct child sessions previously created with spawn-child, then return their terminal statuses and final responses. Use this instead of repeatedly polling get-child-status when a workflow must aggregate child results in the current turn. It blocks only until every named child is terminal or the timeout expires; it never cancels children.",
  args: {
    childIds: z
      .array(z.string().min(1))
      .min(1)
      .max(100)
      .describe("Direct child session IDs returned by spawn-child."),
    timeoutSeconds: z
      .number()
      .int()
      .min(1)
      .max(1800)
      .default(900)
      .describe("Maximum seconds to wait. Defaults to 900 and cannot exceed 1800."),
  },
  async execute(args) {
    try {
      return await waitForChildren(args, { request: bridgeFetch });
    } catch (error) {
      return `Failed to wait for child sessions: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});
