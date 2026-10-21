import type { JsonValue } from "@earendil-works/chord";
import type { ToolHookCall } from "@earendil-works/pi-durable";
import type { ToolPolicyDelegate } from "../harness/tool-policy";
import {
  COMPUTER_SCRATCH_ROOT,
  isProtectedWorkspaceRoot,
  normalizeWorkspaceAbsolutePath,
  resolveWorkspacePath,
} from "../pi/computer-workspace-quota";
import { validateWorkspaceToolInput } from "./workspace-input-limits";

const BEFORE_MEMO = "open-inspect.workspace-policy.before";
const AFTER_MEMO = "open-inspect.workspace-policy.after";
const REPOSITORY_OVERLAY_ROOT = "/workspace/repos";

export const WORKSPACE_MUTATION_MAX_BYTES = 2 * 1024 * 1024;

type MutationDecision =
  | { allowed: true; metadata: Record<string, JsonValue> }
  | { allowed: false; reason: string; metadata: Record<string, JsonValue> };

/** Scratch-only policy contributor for the canonical composite Pi tool policy. */
export function createWorkspaceMutationPolicyDelegate(): ToolPolicyDelegate {
  return {
    async beforeTool(call, declaration, api, context) {
      if (declaration.effect !== "local_mutation") return;
      if (targetsRepositoryOverlay(call)) return;
      const decision = mutationDecision(call);
      if (decision.allowed) return;
      await memoDecision(api, context, call, decision);
      return { block: decision.reason };
    },
    async memoFinalAllow(call, declaration, api, context) {
      if (declaration.effect !== "local_mutation" || targetsRepositoryOverlay(call)) return;
      const decision = mutationDecision(call);
      if (decision.allowed) await memoDecision(api, context, call, decision);
    },
    async afterTool(call, declaration, result, api, context) {
      if (declaration.effect !== "local_mutation" || targetsRepositoryOverlay(call)) {
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
          outcome: mutationOutcome(result),
        },
        context
      );
      return result;
    },
  };
}

function mutationOutcome(result: { isError?: boolean; details?: unknown }): JsonValue {
  if (
    typeof result.details === "object" &&
    result.details !== null &&
    "mutationOutcome" in result.details &&
    result.details.mutationOutcome === "indeterminate_or_applied"
  ) {
    return "indeterminate_or_applied";
  }
  return result.isError === true ? "failed" : "succeeded";
}

async function memoDecision(
  api: Parameters<NonNullable<ToolPolicyDelegate["beforeTool"]>>[2],
  context: Parameters<NonNullable<ToolPolicyDelegate["beforeTool"]>>[3],
  call: ToolHookCall,
  decision: MutationDecision
): Promise<void> {
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
}

function mutationDecision(call: ToolHookCall): MutationDecision {
  let normalized: Record<string, unknown>;
  try {
    normalized = validateWorkspaceToolInput(call.name, call.arguments);
  } catch (error) {
    return {
      allowed: false,
      reason: error instanceof Error ? error.message : "Workspace mutation arguments are invalid",
      metadata: {},
    };
  }
  const boundedCall = { ...call, arguments: normalized } as ToolHookCall;
  const path = pathFrom(boundedCall);
  if (path === null) {
    return {
      allowed: false,
      reason: `Workspace mutation path is outside ${COMPUTER_SCRATCH_ROOT}`,
      metadata: {},
    };
  }
  if (isProtectedWorkspaceRoot(path)) {
    return {
      allowed: false,
      reason: `Workspace mutation must name a path below ${COMPUTER_SCRATCH_ROOT}`,
      metadata: { path },
    };
  }
  switch (boundedCall.name) {
    case "write":
      return writeDecision(boundedCall, path);
    case "edit":
      return editDecision(boundedCall, path);
    case "delete":
      return {
        allowed: true,
        metadata: { path, recursive: boundedCall.arguments.recursive === true },
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
  return { allowed: true, metadata: { path, editCount: edits.length, contentBytes } };
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

function targetsRepositoryOverlay(call: ToolHookCall): boolean {
  const path = call.arguments.path;
  if (typeof path !== "string") return false;
  const normalized = normalizeWorkspaceAbsolutePath(path);
  return (
    normalized === REPOSITORY_OVERLAY_ROOT || normalized.startsWith(`${REPOSITORY_OVERLAY_ROOT}/`)
  );
}
