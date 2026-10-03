import { tool } from "@opencode-ai/plugin";
import { searchMemory } from "./_memory.js";

export default tool({
  description:
    "Find active facts beyond the injected catalog using short literal keyword queries. Every whitespace-separated term must match the title, description, or body; there is no semantic search. Returns IDs and summaries, not bodies: use memory_read for full text. Omit scope to search permitted session scopes. Repository scope searches all attached repos unless both repoOwner and repoName select one. If hasMore is true, refine the query. Stored knowledge may be stale.",
  args: {
    query: tool.schema.string(),
    scope: tool.schema.enum(["personal", "repository", "environment"]).optional(),
    repoOwner: tool.schema.string().optional(),
    repoName: tool.schema.string().optional(),
    limit: tool.schema.number().int().optional(),
  },
  execute: searchMemory,
});
