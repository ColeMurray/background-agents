import {
  PI_CODEMODE_TOOL_EFFECT_REGISTRATIONS,
  createToolEffectRegistry,
} from "@open-inspect/shared/pi-tool-effects";
import type { HookApi, ToolHookCall } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import {
  createOpenInspectCodemodeExtension,
  createPiCodeModePolicyDelegate,
  createPiCodeModePolicyState,
} from "./codemode-extension";

const effects = createToolEffectRegistry([
  { name: "read", effect: "local_read", callers: ["tools"], replay: "safe" },
  { name: "write", effect: "local_mutation", callers: ["tools"], replay: "safe" },
  { name: "unstable", effect: "external_read", callers: ["tools"], replay: "unsafe" },
  ...PI_CODEMODE_TOOL_EFFECT_REGISTRATIONS,
]);
const context = { abortSignal: undefined, value: () => undefined, toString: () => "test" };

function call(name: string, nested = false): ToolHookCall {
  return {
    type: "toolCall",
    id: `call:${name}`,
    name,
    arguments: {},
    ...(nested ? { parent: { taskId: 1 as never, callId: "parent" } } : {}),
  };
}

describe("createOpenInspectCodemodeExtension", () => {
  it("matches the canonical Code Mode effect registrations", () => {
    const sandbox = { start: () => undefined, close: async () => {} } as never;
    const extension = createOpenInspectCodemodeExtension(sandbox, createPiCodeModePolicyState());

    expect(extension.name).toBe("codemode");
    expect(
      extension.tools?.map((tool) => [tool.name, tool.replay ?? "unsafe", tool.callers])
    ).toEqual(
      PI_CODEMODE_TOOL_EFFECT_REGISTRATIONS.map((effect) => [
        effect.name,
        effect.replay,
        effect.callers,
      ])
    );
  });

  it("limits only active Code Mode nested calls to replay-safe reads", async () => {
    const state = createPiCodeModePolicyState();
    state.activeCallIds.add("parent");
    const delegate = createPiCodeModePolicyDelegate(state);
    const api = {} as HookApi;

    await expect(
      delegate.beforeTool?.(call("read", true), effects.get("read")!, api, context)
    ).resolves.toBeUndefined();
    await expect(
      delegate.beforeTool?.(call("write", true), effects.get("write")!, api, context)
    ).resolves.toEqual({ block: "Code Mode may call only replay-safe read tools" });
    await expect(
      delegate.beforeTool?.(call("unstable", true), effects.get("unstable")!, api, context)
    ).resolves.toEqual({ block: "Code Mode may call only replay-safe read tools" });
  });
});
