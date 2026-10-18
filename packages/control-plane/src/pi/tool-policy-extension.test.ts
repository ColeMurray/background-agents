import { createToolEffectRegistry } from "@open-inspect/shared/pi-tool-effects";
import { type HookApi, type ToolHookCall, type ToolHooks } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { createPiToolPolicyExtension } from "./tool-policy-extension";

const effects = createToolEffectRegistry([
  { name: "model_tool", effect: "control", callers: ["model"], replay: "safe" },
  { name: "nested_tool", effect: "local_read", callers: ["tools"], replay: "safe" },
]);

const context = { abortSignal: undefined, value: () => undefined, toString: () => "test" };
const api = {} as HookApi;

function beforeTool() {
  const extension = createPiToolPolicyExtension(effects);
  const registration = extension.hooks?.[0];
  expect(registration?.task).toBe("pi.tool");
  const handler = (registration?.handlers as Partial<ToolHooks> | undefined)?.beforeTool;
  if (!handler) throw new Error("Expected Pi tool policy beforeTool hook");
  return handler;
}

function call(name: string, nested = false): ToolHookCall {
  return {
    type: "toolCall",
    id: `call:${name}`,
    name,
    arguments: {},
    ...(nested ? { parent: { taskId: 1 as never, callId: "parent" } } : {}),
  };
}

describe("createPiToolPolicyExtension", () => {
  it("authorizes model calls only when the exact registry declares the model caller", async () => {
    const hook = beforeTool();

    await expect(hook(call("model_tool"), api, context)).resolves.toBeUndefined();
    await expect(hook(call("nested_tool"), api, context)).resolves.toEqual({
      block: "Pi tool caller is not allowed: model -> nested_tool",
    });
  });

  it("authorizes nested calls only when the exact registry declares the tools caller", async () => {
    const hook = beforeTool();

    await expect(hook(call("nested_tool", true), api, context)).resolves.toBeUndefined();
    await expect(hook(call("model_tool", true), api, context)).resolves.toEqual({
      block: "Pi tool caller is not allowed: tools -> model_tool",
    });
  });

  it("default-denies undeclared model and nested tools", async () => {
    const hook = beforeTool();

    await expect(hook(call("unknown"), api, context)).resolves.toEqual({
      block: "Pi tool is not declared: unknown",
    });
    await expect(hook(call("unknown", true), api, context)).resolves.toEqual({
      block: "Pi tool is not declared: unknown",
    });
  });
});
