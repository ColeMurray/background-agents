import type { Context } from "@earendil-works/chord";
import {
  defineExtension,
  hook,
  ToolTask,
  type HookApi,
  type ToolExecutionResult,
  type ToolHookCall,
} from "@earendil-works/pi-durable";
import type { ToolEffectRegistration } from "@open-inspect/shared/tool-effects";
import type { HarnessActionCeiling } from "../harness/action-ceiling";
import { createToolPolicy, TOOL_POLICY_EXTENSION_NAME } from "../harness/tool-policy";
import type { PiToolEmergencyPolicy, PiToolPolicyDelegate } from "./tool-policy-types";

/**
 * The Pi adapter's install of the seam's policy.
 *
 * The seam decides; the adapter installs. This is the only file that knows
 * both the seam's decision and the Pi runtime's hook, and it maps one to the
 * other: the runtime's call becomes the seam's facts, and the seam's decision
 * becomes the runtime's block.
 */
export interface PiToolPolicyOptions {
  /** Fresh SessionDO authorization for the active turn author. */
  readonly authorizeToolCall: (
    call: ToolHookCall,
    api: HookApi,
    context: Context
  ) => { readonly block: string } | undefined | Promise<{ readonly block: string } | undefined>;
  /** The exact effect registry the runtime exposes. */
  readonly effects: ReadonlyMap<string, ToolEffectRegistration>;
  /** The feature-specific decisions, in order. */
  readonly delegates?: readonly PiToolPolicyDelegate[];
  /** The deployment's kill switch. */
  readonly emergencyPolicy?: PiToolEmergencyPolicy;
  /** The ceiling on what this turn may do. */
  readonly ceiling?: () => HarnessActionCeiling;
}

/** The result the runtime sees when the policy fails closed. */
function policyFailure(message: string): ToolExecutionResult {
  return { isError: true, output: [{ type: "text", text: message }] };
}

/** Whether an error is the turn's own cancellation rather than a policy failure. */
function isCancellation(error: unknown, context: Context): boolean {
  if (error instanceof Error && error.name === "AbortError") return true;
  return context.abortSignal?.aborted === true && context.abortSignal.reason === error;
}

/** The Pi runtime's extension that carries the seam's policy. */
export function createToolPolicyExtension(options: PiToolPolicyOptions) {
  const policy = createToolPolicy<ToolHookCall, HookApi, Context, ToolExecutionResult>({
    authorizeToolCall: options.authorizeToolCall,
    effects: options.effects,
    delegates: options.delegates,
    emergencyPolicy: options.emergencyPolicy,
    ceiling: options.ceiling,
    // A nested call is one a running tool made, so the caller is the tool.
    factsOf: (call) => ({ name: call.name, caller: call.parent ? "tools" : "model" }),
    failureResult: policyFailure,
    isCancellation,
  });

  return defineExtension({
    name: TOOL_POLICY_EXTENSION_NAME,
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call, api, context) => policy.beforeTool(call, api, context),
        afterTool: async (call, result, api, context) =>
          policy.afterTool(call, result, api, context),
      }),
    ],
  });
}
