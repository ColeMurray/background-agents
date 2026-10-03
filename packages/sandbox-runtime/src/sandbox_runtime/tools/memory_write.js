import { tool } from "@opencode-ai/plugin";
import { writeMemory } from "./_memory.js";

export default tool({
  description:
    "Remember non-obvious, durable knowledge. The server infers the session environment or sole repository. For multi-repository sessions, specify both repoOwner and repoName. Write a directive only when the user asks to remember a preference. Never store credentials. Shared memories and directives require approval; the result states active or proposed. Respect the user's personal-memory opt-out.",
  args: {
    scope: tool.schema.enum(["personal", "repository", "environment"]),
    repoOwner: tool.schema
      .string()
      .optional()
      .describe(
        "Repository owner; supply with repoName to select a repository in a multi-repository session"
      ),
    repoName: tool.schema
      .string()
      .optional()
      .describe(
        "Repository name; supply with repoOwner to select a repository in a multi-repository session"
      ),
    memoryType: tool.schema.enum(["fact", "directive"]),
    title: tool.schema.string(),
    description: tool.schema.string(),
    content: tool.schema.string(),
    supersedesMemoryId: tool.schema.string().optional(),
  },
  execute: writeMemory,
});
