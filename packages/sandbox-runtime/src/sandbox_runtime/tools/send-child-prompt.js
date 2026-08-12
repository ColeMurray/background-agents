/**
 * Send Task Prompt Tool — queue a follow-up prompt in a direct child session.
 */
import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import { executeSendChildPrompt } from "./_send-child-prompt.js";

export default tool({
  name: "send-child-prompt",
  description:
    "Queue a follow-up prompt in a direct child session. The prompt runs after any current or queued child work; it does not interrupt the active turn. Completed and failed children can resume, while cancelled and archived children cannot. Use get-child-status when you need the new result.",
  args: {
    childId: z.string().describe("Direct child ID returned by spawn-child."),
    prompt: z.string().describe("Follow-up instructions to queue in the child session."),
  },
  execute: executeSendChildPrompt,
});
