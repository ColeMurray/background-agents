import type { ToolHookCall } from "@earendil-works/pi-durable";
import type { ToolEffectRegistration } from "@open-inspect/shared/tool-effects";
import { normalizeWorkspaceAbsolutePath } from "./computer-workspace-quota";

const REPOSITORY_ROOT = "/workspace/repos";

/**
 * Which of the Pi harness's features a call needs, and the reason to give
 * when the deployment has closed it.
 *
 * The vocabulary is the harness's; the mechanism that checks it belongs to
 * the harness-neutral emergency policy.
 */
export function piEmergencyRequirement(
  call: ToolHookCall,
  declaration: ToolEffectRegistration
): { readonly feature: string; readonly reason: string } | undefined {
  if (isTopLevelCodeMode(call)) {
    return {
      feature: "codeMode",
      reason: "Code Mode is disabled for new calls by deployment policy",
    };
  }

  if (["run_shell", "run_build", "run_tests"].includes(call.name)) {
    return {
      feature: "sandboxExecution",
      reason: "Sandbox execution is disabled by deployment policy",
    };
  }

  // A read inside the session's own scratch space stays operable during an
  // emergency deny. The deny stops new effects and new mutations; it does not
  // strand a turn that is already reading its own workspace.
  const feature = requiredMutationFeature(call, declaration);
  if (!feature) return undefined;
  return {
    feature,
    reason:
      feature === "repositoryEditing"
        ? "Repository mutations are disabled by deployment policy"
        : "Scratch workspace mutations are disabled by deployment policy",
  };
}

function requiredMutationFeature(
  call: ToolHookCall,
  declaration: ToolEffectRegistration
): "scratchWorkspace" | "repositoryEditing" | undefined {
  if (declaration.effect !== "local_mutation") return undefined;
  const path = call.arguments.path;
  const normalized =
    typeof path === "string" ? normalizeWorkspaceAbsolutePath(path) : "/workspace/scratch";
  return normalized === REPOSITORY_ROOT || normalized.startsWith(`${REPOSITORY_ROOT}/`)
    ? "repositoryEditing"
    : "scratchWorkspace";
}

function isTopLevelCodeMode(call: ToolHookCall): boolean {
  return call.name === "codemode" && !call.parent;
}
