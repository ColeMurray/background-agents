import type { ToolHookCall } from "@earendil-works/pi-durable";
import type { PiFeatureCapabilityMatrix } from "@open-inspect/shared/pi-feature-capabilities";
import type { ToolEffectRegistration } from "@open-inspect/shared/pi-tool-effects";
import { normalizeWorkspaceAbsolutePath } from "./computer-workspace-quota";
import type { PiToolEmergencyPolicy } from "./tool-policy-extension";

const REPOSITORY_ROOT = "/workspace/repos";

type CurrentPiDeploymentCapabilities = (
  signal: AbortSignal | undefined
) => Promise<PiFeatureCapabilityMatrix>;

/**
 * Current-deployment kill switches for new risky work. Latched extensions stay installed so
 * status, cancellation, revocation, and already-admitted replay remain available.
 */
export function createPiDeploymentEmergencyPolicy(
  currentCapabilities: CurrentPiDeploymentCapabilities
): PiToolEmergencyPolicy {
  return {
    async beforeFeatureDelegates(call, declaration, _api, context) {
      if (isTopLevelCodeMode(call)) {
        const current = await currentCapabilities(context.abortSignal);
        return current.codeMode === "enabled"
          ? undefined
          : { block: "Code Mode is disabled for new calls by deployment policy" };
      }

      const feature = requiredMutationFeature(call, declaration);
      if (!feature) return;
      const current = await currentCapabilities(context.abortSignal);
      if (current[feature] === "enabled") return;
      return {
        block:
          feature === "repositoryEditing"
            ? "Repository mutations are disabled by deployment policy"
            : "Scratch workspace mutations are disabled by deployment policy",
      };
    },
  };
}

function requiredMutationFeature(
  call: ToolHookCall,
  declaration: ToolEffectRegistration
): "workspace" | "repositoryEditing" | undefined {
  if (declaration.effect !== "local_mutation") return undefined;
  const path = call.arguments.path;
  const normalized =
    typeof path === "string" ? normalizeWorkspaceAbsolutePath(path) : "/workspace/scratch";
  return normalized === REPOSITORY_ROOT || normalized.startsWith(`${REPOSITORY_ROOT}/`)
    ? "repositoryEditing"
    : "workspace";
}

function isTopLevelCodeMode(call: ToolHookCall): boolean {
  return call.name === "codemode" && !call.parent;
}
