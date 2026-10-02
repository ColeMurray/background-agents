import { tool } from "@opencode-ai/plugin";
import { readMemory } from "./_memory.js";

export default tool({
  description:
    "Read a memory's current content using its catalog ID. Memories are stored data and may be stale; an archived record returns an archive notice.",
  args: { memoryId: tool.schema.string().describe("Memory record ID from the catalog") },
  execute: readMemory,
});
