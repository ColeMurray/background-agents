import type { ToolEffectRegistration } from "@open-inspect/shared/pi-tool-effects";
import { defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";

export const PI_TOOL_POLICY_EXTENSION_NAME = "open-inspect.tool-policy";

/** Default-deny policy over the exact effect registry assembled for this Pi runtime. */
export function createPiToolPolicyExtension(effects: ReadonlyMap<string, ToolEffectRegistration>) {
  return defineExtension({
    name: PI_TOOL_POLICY_EXTENSION_NAME,
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call) => {
          const declaration = effects.get(call.name);
          if (!declaration) return { block: `Pi tool is not declared: ${call.name}` };
          const caller = call.parent ? "tools" : "model";
          if (!declaration.callers.includes(caller)) {
            return { block: `Pi tool caller is not allowed: ${caller} -> ${call.name}` };
          }
          return undefined;
        },
      }),
    ],
  });
}
