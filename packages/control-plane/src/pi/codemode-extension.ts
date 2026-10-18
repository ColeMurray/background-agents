import type { CodemodeSandboxBase } from "@earendil-works/pi-codemode/portable";
import { defineExtension } from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import type { PiToolPolicyDelegate } from "./tool-policy-extension";

const CODEMODE_ADMITTED_MEMO = "open-inspect.codemode-admitted";

export interface PiCodeModePolicyState {
  readonly activeCallIds: Set<string>;
  readonly admitNewCalls: boolean;
}

export function createPiCodeModePolicyState(admitNewCalls: boolean): PiCodeModePolicyState {
  return { activeCallIds: new Set(), admitNewCalls };
}

/** Code Mode decisions composed through the one canonical policy extension. */
export function createPiCodeModePolicyDelegate(state: PiCodeModePolicyState): PiToolPolicyDelegate {
  return {
    beforeTool: async (call, declaration, api, context) => {
      if (call.name === "codemode" && !call.parent) {
        const admitted = await api.memo<boolean>(CODEMODE_ADMITTED_MEMO, context);
        if (admitted !== true) {
          if (!state.admitNewCalls) {
            return { block: "Code Mode is disabled for new calls by deployment policy" };
          }
          await api.memo(CODEMODE_ADMITTED_MEMO, true, context);
        }
      }
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
