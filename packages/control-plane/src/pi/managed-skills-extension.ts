import type { ToolResultMessage } from "@earendil-works/pi-ai";
import {
  defineExtension,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { SkillSource } from "agents/skills";

/**
 * Install the official Agents Pi skills extension over Open-Inspect's pinned
 * sources. Agents 0.28.1 was compiled before Pi Durable 1.2 renamed tool-result
 * `content` to `output`, so the narrow adapter below normalizes only that
 * changed field; catalog resolution, activation, resources, and prompt
 * rendering remain the SDK implementation.
 */
export async function createManagedSkillsExtension(sources: readonly SkillSource[]) {
  const { skills } = await import("agents/harness/pi");
  const extension = await skills(sources);
  return defineExtension({
    ...extension,
    name: "open-inspect.skills",
    tools: extension.tools?.map(adaptLegacyToolOutput),
  });
}

function adaptLegacyToolOutput(tool: ToolRegistration): ToolRegistration {
  return {
    ...tool,
    async execute(args, api, context): Promise<ToolExecutionResult> {
      const result = await tool.execute(args, api, context);
      if (result.output !== undefined || !hasLegacyContent(result)) return result;
      return { ...result, output: result.content };
    },
  };
}

function hasLegacyContent(
  result: ToolExecutionResult
): result is ToolExecutionResult & { content: ToolResultMessage["content"] } {
  if (!("content" in result) || !Array.isArray(result.content)) return false;
  return result.content.every(
    (part) =>
      typeof part === "object" &&
      part !== null &&
      (("type" in part &&
        part.type === "text" &&
        "text" in part &&
        typeof part.text === "string") ||
        ("type" in part &&
          part.type === "image" &&
          "data" in part &&
          typeof part.data === "string" &&
          "mimeType" in part &&
          typeof part.mimeType === "string"))
  );
}
