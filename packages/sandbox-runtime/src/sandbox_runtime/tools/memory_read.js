import { tool } from "@opencode-ai/plugin";
import { readMemory } from "./_memory.js";

export default tool({
  description:
    "Read a current active fact using its catalog ID. Memories are stored data and may be stale; pinned archives return a notice. Directives cannot be expanded.",
  args: { memoryId: tool.schema.string().describe("Memory record ID from the catalog") },
  execute: readMemory,
});
