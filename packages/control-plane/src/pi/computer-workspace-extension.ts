import type { Workspace } from "@cloudflare/computer";
import { createPiTools } from "@cloudflare/computer/tools/pi-ai";
import { PI_TOOL_EFFECT_REGISTRY } from "@open-inspect/shared/pi-tool-effects";
import {
  defineExtension,
  section,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { z } from "zod";

const WORKSPACE_ROOT = "/workspace";
const READ_ONLY_TOOL_NAMES = ["read", "ls", "find", "grep"] as const;
const readOnlyToolNames = new Set<string>(READ_ONLY_TOOL_NAMES);

/**
 * Cloudflare Computer's credential-free VFS tools, adapted to Pi Durable 1.3.
 * The explicit allowlist prevents an upstream release from widening the
 * model's capabilities merely by returning another declaration.
 */
export function createComputerWorkspaceExtension(workspace: Workspace) {
  const { tools, execute } = createPiTools({
    workspace,
    root: WORKSPACE_ROOT,
    readonly: true,
    exec: {},
    assets: false,
    constrainedSampling: "prefer",
  });
  const selected = tools.filter((tool) => readOnlyToolNames.has(tool.name));
  const selectedNames = new Set(selected.map((tool) => tool.name));
  for (const name of READ_ONLY_TOOL_NAMES) {
    if (!selectedNames.has(name)) throw new Error(`Computer workspace tool is missing: ${name}`);
  }

  return defineExtension({
    name: "open-inspect.workspace",
    sections: [
      section("workspace", () =>
        [
          `${WORKSPACE_ROOT} is durable session scratch space.`,
          "It survives turns and Durable Object eviction, and is deleted with the Open-Inspect session.",
          "This workspace is read-only for now and is not a repository checkout or repository authority.",
          "When repository_list and repository_read are available, use them for the immutable pinned repository attached to the session.",
          "No shell, Git, network, mounts, publishing, or execution backend is available.",
        ].join(" ")
      ),
    ],
    tools: selected.map((tool): ToolRegistration => {
      const effect = PI_TOOL_EFFECT_REGISTRY.get(tool.name);
      if (!effect)
        throw new Error(`Computer workspace tool has no effect declaration: ${tool.name}`);
      return {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        ...(tool.constrainedSampling === undefined
          ? {}
          : { constrainedSampling: tool.constrainedSampling }),
        replay: effect.replay,
        callers: effect.callers,
        async execute(args, api, context): Promise<ToolExecutionResult> {
          const result = await execute(
            { id: api.callId, name: tool.name, arguments: args },
            { abortSignal: context.abortSignal }
          );
          return {
            output: result.content,
            isError: result.isError,
            ...(result.details === undefined ? {} : { details: z.json().parse(result.details) }),
          };
        },
      };
    }),
  });
}
