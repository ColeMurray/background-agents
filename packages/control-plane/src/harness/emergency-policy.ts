import type { ToolHookCall } from "@earendil-works/pi-durable";
import type { FeatureCapabilityMode } from "@open-inspect/shared/capability-modes";
import type { ToolEffectRegistration } from "@open-inspect/shared/tool-effects";
import type { ToolEmergencyPolicy } from "./tool-policy";

/**
 * The kill switch: current-deployment denial for new risky work.
 *
 * A deployment must be able to stop a capability **without** stranding the
 * work already admitted. Latched extensions therefore stay installed — status,
 * cancellation, revocation and already-admitted replay must remain reachable —
 * and what is denied is the *start* of new work.
 *
 * The mechanism is harness-neutral: the deployment's current capabilities, read
 * now, and a rule that says which feature each risky call needs. The
 * vocabulary — which feature a call belongs to — belongs to the harness.
 */
export interface DeploymentEmergencyPolicyOptions {
  /** The current capability of every feature, read now. */
  currentCapabilities(
    signal: AbortSignal | undefined
  ): Promise<Readonly<Record<string, FeatureCapabilityMode>>>;
  /**
   * The feature a call needs, and the reason to give when it is closed.
   *
   * `undefined` means the call is not one this policy governs.
   */
  requirementFor(
    call: ToolHookCall,
    declaration: ToolEffectRegistration
  ): { readonly feature: string; readonly reason: string } | undefined;
}

/**
 * Current-deployment kill switches for new risky work.
 *
 * Latched extensions stay installed so that status, cancellation, revocation,
 * and already-admitted replay remain available.
 */
export function createDeploymentEmergencyPolicy(
  options: DeploymentEmergencyPolicyOptions
): ToolEmergencyPolicy {
  return {
    async beforeFeatureDelegates(call, declaration, _api, context) {
      const requirement = options.requirementFor(call, declaration);
      if (!requirement) return;
      const current = await options.currentCapabilities(context.abortSignal);
      if (current[requirement.feature] === "enabled") return;
      return { block: requirement.reason };
    },
  };
}
