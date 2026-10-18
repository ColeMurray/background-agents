import type { JsonValue } from "@earendil-works/chord";
import {
  ToolTask,
  defineExtension,
  hook,
  type ToolHookCall,
  type ToolHooks,
} from "@earendil-works/pi-durable";
import {
  COMPUTER_SCRATCH_ROOT,
  isWorkspaceRoot,
  resolveWorkspacePath,
} from "./computer-workspace-quota";
import {
  WORKSPACE_TOOL_EFFECT_OWNER,
  indexPiToolEffects,
  type PiToolEffectMetadata,
} from "./tool-effects";

const BEFORE_MEMO = "open-inspect.workspace-policy.before";
const AFTER_MEMO = "open-inspect.workspace-policy.after";

export const WORKSPACE_MUTATION_MAX_BYTES = 2 * 1024 * 1024;

type MutationDecision =
  | { allowed: true; metadata: Record<string, JsonValue> }
  | { allowed: false; reason: string; metadata: Record<string, JsonValue> };

/** Mandatory durable policy for Computer tools returned by one pinned adapter. */
export function createWorkspaceMutationPolicyExtension(effects: readonly PiToolEffectMetadata[]) {
  return defineExtension({
    name: "open-inspect.workspace-policy",
    hooks: [hook(ToolTask, createWorkspaceMutationPolicyHooks(effects))],
  });
}

export function createWorkspaceMutationPolicyHooks(
  effects: readonly PiToolEffectMetadata[]
): Pick<ToolHooks, "beforeTool" | "afterTool"> {
  const byTool = indexPiToolEffects(effects);
  return {
    async beforeTool(call, api, context) {
      const classification = byTool.get(call.name);
      if (
        classification === undefined ||
        classification.owner !== WORKSPACE_TOOL_EFFECT_OWNER ||
        classification.effect === "local_read" ||
        classification.effect === "external_read" ||
        classification.effect === "external_mutation"
      ) {
        return;
      }
      const decision = mutationDecision(call, classification);
      await api.memo(
        BEFORE_MEMO,
        {
          version: 1,
          scope: "scratch",
          decision: decision.allowed ? "allow" : "deny",
          tool: call.name,
          ...decision.metadata,
        },
        context
      );
      return decision.allowed ? undefined : { block: decision.reason };
    },
    async afterTool(call, result, api, context) {
      const classification = byTool.get(call.name);
      if (
        classification?.owner !== WORKSPACE_TOOL_EFFECT_OWNER ||
        classification.effect !== "local_mutation"
      ) {
        return result;
      }
      const path = pathFrom(call);
      await api.memo(
        AFTER_MEMO,
        {
          version: 1,
          scope: "scratch",
          tool: call.name,
          ...(path === null ? {} : { path }),
          outcome: result.isError === true ? "failed" : "succeeded",
        },
        context
      );
      return result;
    },
  };
}

function mutationDecision(
  call: ToolHookCall,
  classification: PiToolEffectMetadata
): MutationDecision {
  if (classification.effect !== "local_mutation") {
    return {
      allowed: false,
      reason: `Workspace mutation is not allowed: ${call.name}`,
      metadata: {},
    };
  }
  const path = pathFrom(call);
  if (path === null) {
    return {
      allowed: false,
      reason: `Workspace mutation path is outside ${COMPUTER_SCRATCH_ROOT}`,
      metadata: {},
    };
  }
  if (isWorkspaceRoot(path)) {
    return {
      allowed: false,
      reason: `Workspace mutation must name a path below ${COMPUTER_SCRATCH_ROOT}`,
      metadata: { path },
    };
  }
  switch (classification.operation) {
    case "write":
      return writeDecision(call, path);
    case "edit":
      return editDecision(call, path);
    case "delete":
      return {
        allowed: true,
        metadata: {
          path,
          recursive: call.arguments.recursive === true,
        },
      };
    default:
      return {
        allowed: false,
        reason: `Workspace mutation is not allowed: ${call.name}`,
        metadata: { path },
      };
  }
}

function writeDecision(call: ToolHookCall, path: string): MutationDecision {
  const content = call.arguments.content;
  if (typeof content !== "string") return invalidArguments(call.name, path);
  const contentBytes = new TextEncoder().encode(content).byteLength;
  if (contentBytes > WORKSPACE_MUTATION_MAX_BYTES) {
    return {
      allowed: false,
      reason: `Workspace write is too large (${contentBytes} bytes)`,
      metadata: { path, contentBytes },
    };
  }
  return { allowed: true, metadata: { path, contentBytes } };
}

function editDecision(call: ToolHookCall, path: string): MutationDecision {
  const edits = call.arguments.edits;
  if (!Array.isArray(edits)) return invalidArguments(call.name, path);
  let contentBytes = 0;
  for (const edit of edits) {
    if (
      typeof edit !== "object" ||
      edit === null ||
      !("oldText" in edit) ||
      typeof edit.oldText !== "string" ||
      !("newText" in edit) ||
      typeof edit.newText !== "string"
    ) {
      return invalidArguments(call.name, path);
    }
    contentBytes += new TextEncoder().encode(edit.oldText).byteLength;
    contentBytes += new TextEncoder().encode(edit.newText).byteLength;
    if (contentBytes > WORKSPACE_MUTATION_MAX_BYTES) {
      return {
        allowed: false,
        reason: `Workspace edit is too large (${contentBytes} bytes)`,
        metadata: { path, editCount: edits.length, contentBytes },
      };
    }
  }
  return {
    allowed: true,
    metadata: { path, editCount: edits.length, contentBytes },
  };
}

function invalidArguments(tool: string, path: string): MutationDecision {
  return {
    allowed: false,
    reason: `Workspace mutation has invalid arguments: ${tool}`,
    metadata: { path },
  };
}

function pathFrom(call: ToolHookCall): string | null {
  const path = call.arguments.path;
  return typeof path === "string" ? resolveWorkspacePath(path) : null;
}
