import { createPiTools, type PiToolResult } from "@cloudflare/computer/tools/pi-ai";
import {
  PI_TOOL_EFFECT_REGISTRY,
  type ToolEffectRegistration,
} from "@open-inspect/shared/pi-tool-effects";
import {
  defineExtension,
  section,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { z } from "zod";
import type { FeatureCapabilityMode } from "@open-inspect/shared/pi-feature-capabilities";
import {
  COMPUTER_SCRATCH_ROOT,
  WorkspaceMutationFifo,
  isProtectedWorkspaceRoot,
  type WorkspaceToolFacade,
} from "./computer-workspace-quota";
import {
  WORKSPACE_MUTATION_MAX_BYTES,
  createWorkspaceMutationPolicyDelegate,
} from "./computer-workspace-policy";
import { validateWorkspaceToolInput } from "./workspace-input-limits";

const READ_ONLY_TOOL_NAMES = ["read", "ls", "find", "grep"] as const;
const MUTATION_TOOL_NAMES = ["write", "edit", "delete"] as const;
const readOnlyToolNames = new Set<string>(READ_ONLY_TOOL_NAMES);

/**
 * Whether repeating a mutation is harmless.
 *
 * This follows the Computer SDK's own policy, which the Cloudflare Agents
 * example states: a whole-file write and a delete are replay-safe, because
 * writing the same bytes and deleting an absent file change nothing, while an
 * edit is not, because a second run would look for text the first run already
 * replaced. The diff publication replaces the bundle with the same content and
 * is fenced by the publication generation, so a repeated mutation leaves the
 * session's diff exactly as it was.
 */
const REPLAY_SAFE_MUTATION_TOOL_NAMES = new Set<string>(["write", "delete"]);

export const COMPUTER_WORKSPACE_MUTATION_EFFECTS = MUTATION_TOOL_NAMES.map(
  (name): ToolEffectRegistration => ({
    name,
    effect: "local_mutation",
    callers: ["model", "tools"],
    replay: REPLAY_SAFE_MUTATION_TOOL_NAMES.has(name) ? "safe" : "unsafe",
  })
);
const mutationEffects = new Map(
  COMPUTER_WORKSPACE_MUTATION_EFFECTS.map((effect) => [effect.name, effect])
);

/**
 * Cloudflare Computer's credential-free VFS tools, adapted to Pi Durable 1.3.
 * The explicit allowlist prevents an upstream release from widening the
 * model's capabilities merely by returning another declaration.
 */
export function createComputerWorkspaceCapability(
  workspace: WorkspaceToolFacade,
  mode: Exclude<FeatureCapabilityMode, "off">,
  mutations = new WorkspaceMutationFifo()
) {
  const writable = mode === "enabled";
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
    name: "open-inspect.scratch-workspace",
    sections: [
      section("scratch_workspace", () =>
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
    tools: selected.map((tool): ToolRegistration => {
      const declaration = workspaceToolEffect(tool.name);
      if (!declaration) {
        throw new Error(`Computer workspace tool has no effect declaration: ${tool.name}`);
      }
      const mutating = declaration.effect === "local_mutation";
      return {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        ...(tool.constrainedSampling === undefined
          ? {}
          : { constrainedSampling: tool.constrainedSampling }),
        replay: declaration.replay,
        callers: declaration.callers,
        prepareArguments: (args) => validateWorkspaceToolInput(tool.name, args, tool.parameters),
        ...(mutating ? { executionMode: "sequential" as const } : {}),
        async execute(args, api, context): Promise<ToolExecutionResult> {
          let boundedArgs: Record<string, unknown>;
          try {
            boundedArgs = validateWorkspaceToolInput(tool.name, args, tool.parameters);
          } catch (error) {
            return toolError(error);
          }
          if (tool.name === "delete" && deletesWorkspaceRoot(boundedArgs)) {
            return {
              output: [{ type: "text", text: "Deleting the workspace root is not allowed" }],
              isError: true,
            };
          }
          let dispatched = false;
          const invoke = (): Promise<PiToolResult> => {
            if (mutating && context.abortSignal?.aborted) {
              return Promise.resolve({
                content: [{ type: "text" as const, text: "Workspace mutation was cancelled" }],
                isError: true,
              });
            }
            dispatched = true;
            return execute(
              { id: api.callId, name: tool.name, arguments: boundedArgs },
              { abortSignal: context.abortSignal }
            );
          };
          let result = mutating ? await mutations.run(invoke) : await invoke();
          if (mutating && dispatched && context.abortSignal?.aborted) {
            result = {
              content: [
                {
                  type: "text",
                  text: "Workspace mutation was dispatched when cancellation arrived; outcome is indeterminate and durable quota state was reconciled.",
                },
              ],
              isError: true,
              details: { mutationOutcome: "indeterminate_or_applied", reconciled: true },
            };
          }
          const details = normalizeDetails(result.details);
          // The write keeps the attribution of the turn that caused it: the
          // task and the call. The timeline attaches the operation, and the
          // operation names the participant.
          const attributed =
            mutating && details !== undefined
              ? {
                  ...(details as Record<string, unknown>),
                  ...(api.taskId === undefined ? {} : { scratchTaskId: String(api.taskId) }),
                  scratchCallId: api.callId,
                }
              : details;
          return {
            output: result.content,
            isError: result.isError,
            ...(attributed === undefined ? {} : { details: attributed }),
          };
        },
      };
    }),
  });
  const effects = selected.map((tool): ToolEffectRegistration => {
    const declaration = workspaceToolEffect(tool.name);
    if (!declaration) {
      throw new Error(`Computer workspace tool has no effect declaration: ${tool.name}`);
    }
    return declaration;
  });
  return {
    extension,
    effects,
    ...(writable
      ? {
          toolPolicyDelegate: createWorkspaceMutationPolicyDelegate(),
        }
      : {}),
  };
}

function toolError(error: unknown): ToolExecutionResult {
  return {
    output: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
    isError: true,
  };
}

function workspaceToolEffect(name: string): ToolEffectRegistration | undefined {
  return PI_TOOL_EFFECT_REGISTRY.get(name) ?? mutationEffects.get(name);
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
