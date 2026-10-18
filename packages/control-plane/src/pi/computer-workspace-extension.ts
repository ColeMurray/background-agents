import type { Workspace } from "@cloudflare/computer";
import { createPiTools, type PiToolResult } from "@cloudflare/computer/tools/pi-ai";
import {
  defineExtension,
  section,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { z } from "zod";
import type { ComputerWorkspaceMode } from "./computer-workspace-mode";
import {
  COMPUTER_SCRATCH_ROOT,
  WorkspaceMutationFifo,
  isProtectedWorkspaceRoot,
} from "./computer-workspace-quota";
import {
  WORKSPACE_MUTATION_MAX_BYTES,
  createWorkspaceMutationPolicyExtension,
} from "./computer-workspace-policy";
import { WORKSPACE_TOOL_EFFECT_OWNER, type PiToolEffectMetadata } from "./tool-effects";

const READ_ONLY_TOOL_NAMES = ["read", "ls", "find", "grep"] as const;
const MUTATION_TOOL_NAMES = ["write", "edit", "delete"] as const;
const readOnlyToolNames = new Set<string>(READ_ONLY_TOOL_NAMES);
const mutationToolNames = new Set<string>(MUTATION_TOOL_NAMES);

/**
 * Cloudflare Computer's credential-free VFS tools, adapted to Pi Durable 1.3.
 * The explicit allowlist prevents an upstream release from widening the
 * model's capabilities merely by returning another declaration.
 */
export function createComputerWorkspaceCapability(
  workspace: Workspace,
  mode: Exclude<ComputerWorkspaceMode, "off">,
  mutations = new WorkspaceMutationFifo()
) {
  const writable = mode === "writable";
  const { tools, execute } = createPiTools({
    workspace,
    root: COMPUTER_SCRATCH_ROOT,
    readonly: !writable,
    exec: {},
    assets: false,
    write: { maxBytes: WORKSPACE_MUTATION_MAX_BYTES },
    edit: { maxBytes: WORKSPACE_MUTATION_MAX_BYTES },
    constrainedSampling: "prefer",
  });
  const allowedNames = writable
    ? new Set<string>([...READ_ONLY_TOOL_NAMES, ...MUTATION_TOOL_NAMES])
    : readOnlyToolNames;
  const selected = tools.filter((tool) => allowedNames.has(tool.name));
  const selectedNames = new Set(selected.map((tool) => tool.name));
  for (const name of READ_ONLY_TOOL_NAMES) {
    if (!selectedNames.has(name)) throw new Error(`Computer workspace tool is missing: ${name}`);
  }
  if (writable) {
    for (const name of MUTATION_TOOL_NAMES) {
      if (!selectedNames.has(name)) throw new Error(`Computer workspace tool is missing: ${name}`);
    }
  }

  const extension = defineExtension({
    name: "open-inspect.workspace",
    sections: [
      section("workspace", () =>
        [
          `${COMPUTER_SCRATCH_ROOT} is durable session scratch space.`,
          "It survives turns and Durable Object eviction, and is deleted with the Open-Inspect session.",
          writable
            ? "You may write, edit, and delete scratch files, subject to the session quota."
            : "This workspace is read-only for now.",
          "It is not a repository checkout or repository authority.",
          "When repository_list and repository_read are available, use them for the immutable pinned repository attached to the session.",
          "No shell, Git, network, mounts, publishing, or execution backend is available.",
        ].join(" ")
      ),
    ],
    tools: selected.map((tool): ToolRegistration => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      ...(tool.constrainedSampling === undefined
        ? {}
        : { constrainedSampling: tool.constrainedSampling }),
      replay: mutationToolNames.has(tool.name) ? "unsafe" : "safe",
      ...(mutationToolNames.has(tool.name) ? { executionMode: "sequential" as const } : {}),
      async execute(args, api, context): Promise<ToolExecutionResult> {
        const mutating = mutationToolNames.has(tool.name);
        if (tool.name === "delete" && deletesWorkspaceRoot(args)) {
          return {
            output: [{ type: "text", text: "Deleting the workspace root is not allowed" }],
            isError: true,
          };
        }
        const invoke = (): Promise<PiToolResult> => {
          if (mutating && context.abortSignal?.aborted) {
            return Promise.resolve({
              content: [{ type: "text" as const, text: "Workspace mutation was cancelled" }],
              isError: true,
            });
          }
          return execute(
            { id: api.callId, name: tool.name, arguments: args },
            { abortSignal: context.abortSignal }
          );
        };
        const result = mutating ? await mutations.run(invoke) : await invoke();
        const details = normalizeDetails(result.details);
        return {
          output: result.content,
          isError: result.isError,
          ...(details === undefined ? {} : { details }),
        };
      },
    })),
  });
  const effects = tools.map((tool): PiToolEffectMetadata => ({
    tool: tool.name,
    effect: readOnlyToolNames.has(tool.name)
      ? "local_read"
      : mutationToolNames.has(tool.name)
        ? "local_mutation"
        : "unclassified",
    owner: WORKSPACE_TOOL_EFFECT_OWNER,
    operation: tool.name,
  }));
  return {
    extensions: [extension, ...(writable ? [createWorkspaceMutationPolicyExtension(effects)] : [])],
    effects,
  };
}

function normalizeDetails(value: unknown) {
  if (value === undefined) return undefined;
  const serialized = JSON.stringify(value);
  return serialized === undefined ? undefined : z.json().parse(JSON.parse(serialized));
}

function deletesWorkspaceRoot(args: unknown): boolean {
  return (
    typeof args === "object" &&
    args !== null &&
    "path" in args &&
    typeof args.path === "string" &&
    isProtectedWorkspaceRoot(args.path)
  );
}
