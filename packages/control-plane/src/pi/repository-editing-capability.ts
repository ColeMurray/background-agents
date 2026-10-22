import { createPiTools, type PiToolResult } from "@cloudflare/computer/tools/pi-ai";
import {
  PI_TOOL_EFFECT_REGISTRY,
  type ToolEffectRegistration,
} from "@open-inspect/shared/pi-runtime-tool-effects";
import type { SessionDiffUpload } from "@open-inspect/shared/types/session-diffs";
import {
  defineExtension,
  section,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { z } from "zod";
import {
  COMPUTER_SCRATCH_ROOT,
  normalizeWorkspaceAbsolutePath,
  type WorkspaceToolFacade,
} from "../pi/computer-workspace-quota";
import type { WorkspaceMutationFifo } from "../pi/computer-workspace-quota";
import { COMPUTER_WORKSPACE_MUTATION_EFFECTS } from "./computer-workspace-extension";
import {
  WORKSPACE_MUTATION_MAX_BYTES,
  createWorkspaceMutationPolicyDelegate,
} from "./computer-workspace-policy";
import type { PiToolPolicyDelegate } from "./tool-policy-types";
import type { PiRepositoryWorkspace, RepositoryMutationName } from "./repository-workspace";
import { validateWorkspaceToolInput } from "./workspace-input-limits";

const REPOSITORY_ROOT = "/workspace/repos";
const READ_TOOL_NAMES = ["read", "ls", "find", "grep"] as const;
const MUTATION_TOOL_NAMES = ["write", "edit", "delete"] as const;
const readToolNames = new Set<string>(READ_TOOL_NAMES);
const mutationToolNames = new Set<string>(MUTATION_TOOL_NAMES);
const mutationEffects = new Map(
  COMPUTER_WORKSPACE_MUTATION_EFFECTS.map((effect) => [effect.name, effect])
);

interface RepositoryEditingCapabilityOptions {
  scratchWorkspace: WorkspaceToolFacade;
  repositoryWorkspace: WorkspaceToolFacade;
  initializeOverlay(signal?: AbortSignal): Promise<PiRepositoryWorkspace>;
  mutations: WorkspaceMutationFifo;
  scratchMode: "off" | "read_only" | "enabled";
  publishDiff(bundle: SessionDiffUpload): Promise<void>;
  triggerMessageId(): Promise<string | null>;
}

/** One canonical workspace contribution routing scratch and repository paths through one FIFO. */
export function createRepositoryEditingWorkspaceCapability(
  options: RepositoryEditingCapabilityOptions
) {
  const scratch = createPiTools({
    workspace: options.scratchWorkspace,
    root: COMPUTER_SCRATCH_ROOT,
    readonly: options.scratchMode !== "enabled",
    exec: {},
    assets: false,
    write: { maxBytes: WORKSPACE_MUTATION_MAX_BYTES },
    edit: { maxBytes: WORKSPACE_MUTATION_MAX_BYTES },
    constrainedSampling: "prefer",
  });
  const repository = createPiTools({
    workspace: options.repositoryWorkspace,
    root: REPOSITORY_ROOT,
    readonly: false,
    exec: {},
    assets: false,
    write: { maxBytes: WORKSPACE_MUTATION_MAX_BYTES },
    edit: { maxBytes: WORKSPACE_MUTATION_MAX_BYTES },
    constrainedSampling: "prefer",
  });
  const declarations = repository.tools.filter(
    ({ name }) => readToolNames.has(name) || mutationToolNames.has(name)
  );
  const names = new Set(declarations.map(({ name }) => name));
  for (const name of [...READ_TOOL_NAMES, ...MUTATION_TOOL_NAMES]) {
    if (!names.has(name)) throw new Error(`Repository workspace tool is missing: ${name}`);
  }

  const extension = defineExtension({
    name: "open-inspect.workspace",
    sections: [
      section("scratch_workspace", () =>
        [
          `${REPOSITORY_ROOT}/{position} contains durable repository overlays.`,
          `${COMPUTER_SCRATCH_ROOT} remains the canonical scratch workspace.`,
          options.scratchMode === "enabled"
            ? "Scratch and repository mutations share one ordered workspace queue."
            : options.scratchMode === "read_only"
              ? "Scratch is read-only; repository mutations use the ordered workspace queue."
              : "Scratch tools are disabled; repository mutations use the ordered workspace queue.",
          "No shell, Git, network, mounts, publishing, or execution backend is available.",
        ].join(" ")
      ),
    ],
    tools: declarations.map((tool): ToolRegistration => {
      const effect = toolEffect(tool.name);
      if (!effect)
        throw new Error(`Repository workspace tool has no effect declaration: ${tool.name}`);
      const mutating = effect.effect === "local_mutation";
      return {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        ...(tool.constrainedSampling === undefined
          ? {}
          : { constrainedSampling: tool.constrainedSampling }),
        replay: effect.replay,
        callers: effect.callers,
        prepareArguments: (args) => validateWorkspaceToolInput(tool.name, args, tool.parameters),
        ...(mutating ? { executionMode: "sequential" as const } : {}),
        async execute(args, api, context): Promise<ToolExecutionResult> {
          let record: Record<string, unknown>;
          try {
            record = validateWorkspaceToolInput(tool.name, args, tool.parameters);
          } catch (error) {
            return toolError(error);
          }
          const repositoryPath = targetsRepository(record);
          const selected = repositoryPath ? repository : scratch;
          let overlay: PiRepositoryWorkspace | undefined;
          if (repositoryPath) {
            try {
              overlay = await options.initializeOverlay(context.abortSignal);
            } catch (error) {
              return toolError(error);
            }
          }
          let dispatched = false;
          const invoke = (): Promise<PiToolResult> => {
            if (context.abortSignal?.aborted) {
              return Promise.resolve({
                content: [{ type: "text", text: "Workspace operation aborted" }],
                isError: true,
              });
            }
            if (!repositoryPath && options.scratchMode === "off") {
              return Promise.resolve({
                content: [{ type: "text", text: "Scratch workspace is disabled" }],
                isError: true,
              });
            }
            dispatched = true;
            return selected.execute(
              { id: api.callId, name: tool.name, arguments: record },
              { abortSignal: context.abortSignal }
            );
          };
          let result: PiToolResult;
          let repositoryProjection: "published" | "pending" | "failed" | undefined;
          if (mutating && repositoryPath) {
            const outcome = await overlay!.runMutation(
              tool.name as RepositoryMutationName,
              record,
              invoke,
              options.publishDiff,
              options.triggerMessageId
            );
            result = outcome.value;
            repositoryProjection = outcome.projection;
            if (outcome.mutation === "applied" && outcome.projection !== "published") {
              result = {
                ...result,
                content: [
                  ...result.content,
                  {
                    type: "text",
                    text:
                      outcome.projection === "pending"
                        ? "Mutation applied; repository diff projection is pending durable retry."
                        : "Mutation applied; repository diff projection is not durably queued and requires manual retry.",
                  },
                ],
                details: mergeProjectionDetails(result.details, outcome.projection),
              };
            }
          } else if (mutating) {
            if (options.scratchMode !== "enabled") {
              result = {
                content: [{ type: "text", text: "Scratch workspace is read-only" }],
                isError: true,
              };
            } else {
              result = await options.mutations.run(invoke);
            }
          } else {
            result = await invoke();
          }
          if (mutating && dispatched && context.abortSignal?.aborted) {
            result = {
              content: [
                {
                  type: "text",
                  text: `Workspace mutation was dispatched when cancellation arrived; outcome is indeterminate, durable state was reconciled${repositoryProjection ? `, and diff projection is ${repositoryProjection}` : ""}.`,
                },
              ],
              isError: true,
              details: {
                mutationOutcome: "indeterminate_or_applied",
                reconciled: true,
                ...(repositoryProjection ? { projection: repositoryProjection } : {}),
              },
            };
          }
          const details = normalizeDetails(result.details);
          return {
            output: result.content,
            isError: result.isError,
            ...(details === undefined ? {} : { details }),
          };
        },
      };
    }),
  });
  const effects = declarations.map(({ name }) => {
    const effect = toolEffect(name);
    if (!effect) throw new Error(`Repository workspace tool has no effect declaration: ${name}`);
    return effect;
  });
  return {
    extension,
    effects,
    toolPolicyDelegate: combinePolicies(
      createWorkspaceMutationPolicyDelegate(),
      createRepositoryMutationPolicyDelegate(options.scratchMode === "enabled")
    ),
  };
}

function toolError(error: unknown): ToolExecutionResult {
  return {
    output: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
    isError: true,
  };
}

function toolEffect(name: string): ToolEffectRegistration | undefined {
  return PI_TOOL_EFFECT_REGISTRY.get(name) ?? mutationEffects.get(name);
}

function targetsRepository(args: Record<string, unknown>): boolean {
  const path = args.path;
  if (typeof path !== "string") return false;
  const normalized = normalizeWorkspaceAbsolutePath(path);
  return normalized === REPOSITORY_ROOT || normalized.startsWith(`${REPOSITORY_ROOT}/`);
}

function createRepositoryMutationPolicyDelegate(scratchWritable: boolean): PiToolPolicyDelegate {
  return {
    async beforeTool(call, declaration) {
      if (declaration.effect !== "local_mutation") return;
      let argumentsValue: Record<string, unknown>;
      try {
        argumentsValue = validateWorkspaceToolInput(call.name, call.arguments);
      } catch (error) {
        return {
          block:
            error instanceof Error ? error.message : "Repository mutation arguments are invalid",
        };
      }
      const path =
        typeof argumentsValue.path === "string"
          ? normalizeWorkspaceAbsolutePath(argumentsValue.path)
          : null;
      if (path?.startsWith(`${REPOSITORY_ROOT}/`)) {
        return;
      }
      if (scratchWritable) return;
      return { block: "Scratch workspace is read-only" };
    },
    async memoFinalAllow(call, declaration, api, context) {
      if (declaration.effect !== "local_mutation") return;
      const boundedArguments = validateWorkspaceToolInput(call.name, call.arguments);
      const path =
        typeof boundedArguments.path === "string"
          ? normalizeWorkspaceAbsolutePath(boundedArguments.path)
          : null;
      if (!path?.startsWith(`${REPOSITORY_ROOT}/`)) return;
      await api.memo(
        "open-inspect.repository-policy.before",
        { version: 1, scope: "repository", decision: "allow", tool: call.name, path },
        context
      );
    },
    async afterTool(call, declaration, result, api, context) {
      if (declaration.effect !== "local_mutation") return result;
      const path =
        typeof call.arguments.path === "string"
          ? normalizeWorkspaceAbsolutePath(call.arguments.path)
          : null;
      if (!path?.startsWith(`${REPOSITORY_ROOT}/`)) return result;
      await api.memo(
        "open-inspect.repository-policy.after",
        {
          version: 1,
          scope: "repository",
          tool: call.name,
          path,
          outcome:
            typeof result.details === "object" &&
            result.details !== null &&
            "mutationOutcome" in result.details &&
            result.details.mutationOutcome === "indeterminate_or_applied"
              ? "indeterminate_or_applied"
              : result.isError === true
                ? "failed"
                : "succeeded",
        },
        context
      );
      return result;
    },
  };
}

function combinePolicies(...delegates: PiToolPolicyDelegate[]): PiToolPolicyDelegate {
  return {
    async beforeTool(call, declaration, api, context) {
      for (const delegate of delegates) {
        const decision = await delegate.beforeTool?.(call, declaration, api, context);
        if (decision !== undefined) return decision;
      }
      return undefined;
    },
    async afterTool(call, declaration, result, api, context) {
      let next = result;
      for (const delegate of delegates) {
        if (delegate.afterTool)
          next = await delegate.afterTool(call, declaration, next, api, context);
      }
      return next;
    },
    async memoFinalAllow(call, declaration, api, context) {
      for (const delegate of delegates) {
        await delegate.memoFinalAllow?.(call, declaration, api, context);
      }
    },
  };
}

function normalizeDetails(value: unknown) {
  if (value === undefined) return undefined;
  const serialized = JSON.stringify(value);
  return serialized === undefined ? undefined : z.json().parse(JSON.parse(serialized));
}

function mergeProjectionDetails(
  value: unknown,
  projection: "pending" | "failed"
): Record<string, unknown> {
  return {
    ...(typeof value === "object" && value !== null && !Array.isArray(value) ? value : {}),
    mutationApplied: true,
    projection,
  };
}
