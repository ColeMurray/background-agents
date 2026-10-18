import type { CodemodeSandboxBase } from "@earendil-works/pi-codemode/portable";
import { defineExtension } from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import type { PiToolPolicyDelegate } from "./tool-policy-extension";

export interface PiCodeModePolicyState {
  readonly activeCallIds: Set<string>;
}

export function createPiCodeModePolicyState(): PiCodeModePolicyState {
  return { activeCallIds: new Set() };
}

/** Code Mode decisions composed through the one canonical policy extension. */
export function createPiCodeModePolicyDelegate(state: PiCodeModePolicyState): PiToolPolicyDelegate {
  return {
    beforeTool: async (call, declaration) => {
      if (call.parent && state.activeCallIds.has(call.parent.callId)) {
        const read = declaration.effect === "local_read" || declaration.effect === "external_read";
        if (!read || declaration.replay !== "safe") {
          return { block: "Code Mode may call only replay-safe read tools" };
        }
      }
      return undefined;
    },
  };
}

/** Native Code Mode with active-call tracking consumed by the composite policy. */
export function createOpenInspectCodemodeExtension(
  sandbox: CodemodeSandboxBase,
  policy: PiCodeModePolicyState
) {
  const extension = createCodemodeExtension({ sandbox });
  return defineExtension({
    ...extension,
    tools: extension.tools?.map((tool) =>
      tool.name !== "codemode"
        ? tool
        : {
            ...tool,
            async execute(args, api, context) {
              policy.activeCallIds.add(api.callId);
              try {
                return await tool.execute(args, api, context);
              } finally {
                policy.activeCallIds.delete(api.callId);
              }
            },
          }
    ),
  });
}
