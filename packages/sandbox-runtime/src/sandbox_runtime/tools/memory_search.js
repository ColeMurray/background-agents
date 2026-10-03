import { tool } from "@opencode-ai/plugin";
import { memoryToolDefinition } from "./_memory.js";

export default tool(memoryToolDefinition(tool.schema, "memory_search"));
