import type { ToolEffectRegistration } from "@open-inspect/shared/pi-tool-effects";
import type { Context } from "@earendil-works/chord";
import {
  defineExtension,
  hook,
  ToolTask,
  type HookApi,
  type ToolExecutionResult,
  type ToolHookCall,
} from "@earendil-works/pi-durable";

export const PI_TOOL_POLICY_EXTENSION_NAME = "open-inspect.tool-policy";

/** Feature-specific decisions composed behind the one canonical policy hook. */
export interface PiToolPolicyDelegate {
  beforeTool?(
    call: ToolHookCall,
    declaration: ToolEffectRegistration,
    api: HookApi,
    context: Context
  ): Promise<{ readonly block: string } | undefined>;
  memoFinalAllow?(
    call: ToolHookCall,
    declaration: ToolEffectRegistration,
    api: HookApi,
    context: Context
  ): Promise<void>;
  afterTool?(
    call: ToolHookCall,
    declaration: ToolEffectRegistration,
    result: ToolExecutionResult,
    api: HookApi,
    context: Context
  ): Promise<ToolExecutionResult>;
}

/** Broad deployment denial runs before feature delegates; durable allow memos run only after them. */
export interface PiToolEmergencyPolicy {
  beforeFeatureDelegates(
    call: ToolHookCall,
    declaration: ToolEffectRegistration,
    api: HookApi,
    context: Context
  ): Promise<{ readonly block: string } | undefined>;
}

/** Default-deny policy over the exact effect registry assembled for this Pi runtime. */
export function createPiToolPolicyExtension(
  effects: ReadonlyMap<string, ToolEffectRegistration>,
  delegates: readonly PiToolPolicyDelegate[] = [],
  emergencyPolicy?: PiToolEmergencyPolicy
) {
  return defineExtension({
    name: PI_TOOL_POLICY_EXTENSION_NAME,
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call, api, context) => {
          const declaration = effects.get(call.name);
          if (!declaration) return { block: `Pi tool is not declared: ${call.name}` };
          const caller = call.parent ? "tools" : "model";
          if (!declaration.callers.includes(caller)) {
            return { block: `Pi tool caller is not allowed: ${caller} -> ${call.name}` };
          }
          const emergencyDecision = await emergencyPolicy?.beforeFeatureDelegates(
            call,
            declaration,
            api,
            context
          );
          if (emergencyDecision !== undefined) return emergencyDecision;
          for (const delegate of delegates) {
            const decision = await delegate.beforeTool?.(call, declaration, api, context);
            if (decision !== undefined) return decision;
          }
          for (const delegate of delegates) {
            await delegate.memoFinalAllow?.(call, declaration, api, context);
          }
          return undefined;
        },
        afterTool: async (call, result, api, context) => {
          const declaration = effects.get(call.name);
          if (!declaration) return policyError(`Pi tool is not declared: ${call.name}`);
          let next = result;
          for (const delegate of delegates) {
            if (!delegate.afterTool) continue;
            try {
              next = await delegate.afterTool(call, declaration, next, api, context);
            } catch (error) {
              if (isAbortError(error, context)) throw error;
              return policyError("Pi tool policy failed closed");
            }
          }
          return next;
        },
      }),
    ],
  });
}

function policyError(message: string): ToolExecutionResult {
  return { isError: true, output: [{ type: "text", text: message }] };
}

function isAbortError(error: unknown, context: Context): boolean {
  if (error instanceof Error && error.name === "AbortError") return true;
  return context.abortSignal?.aborted === true && context.abortSignal.reason === error;
}
