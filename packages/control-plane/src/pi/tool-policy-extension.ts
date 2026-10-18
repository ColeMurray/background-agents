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
  afterTool?(
    call: ToolHookCall,
    declaration: ToolEffectRegistration,
    result: ToolExecutionResult,
    api: HookApi,
    context: Context
  ): Promise<ToolExecutionResult>;
}

/** Default-deny policy over the exact effect registry assembled for this Pi runtime. */
export function createPiToolPolicyExtension(
  effects: ReadonlyMap<string, ToolEffectRegistration>,
  delegates: readonly PiToolPolicyDelegate[] = []
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
          for (const delegate of delegates) {
            const decision = await delegate.beforeTool?.(call, declaration, api, context);
            if (decision !== undefined) return decision;
          }
          return undefined;
        },
        afterTool: async (call, result, api, context) => {
          const declaration = effects.get(call.name);
          if (!declaration) return policyError(`Pi tool is not declared: ${call.name}`);
          let next = result;
          for (const delegate of delegates) {
            if (delegate.afterTool)
              next = await delegate.afterTool(call, declaration, next, api, context);
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
