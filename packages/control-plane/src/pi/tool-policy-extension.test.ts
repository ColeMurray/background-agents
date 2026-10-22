import { createToolEffectRegistry } from "@open-inspect/shared/pi-tool-effects";
import {
  type HookApi,
  type ToolExecutionResult,
  type ToolHookCall,
  type ToolHooks,
} from "@earendil-works/pi-durable";
import { describe, expect, it, vi } from "vitest";
import { createFixedActionCeiling } from "../harness/action-ceiling";
import { createToolPolicyExtension } from "./tool-policy-extension";
import type { PiToolEmergencyPolicy, PiToolPolicyDelegate } from "./tool-policy-types";

const effects = createToolEffectRegistry([
  { name: "model_tool", effect: "control", callers: ["model"], replay: "safe" },
  { name: "nested_tool", effect: "local_read", callers: ["tools"], replay: "safe" },
]);

const context = { abortSignal: undefined, value: () => undefined, toString: () => "test" };
const api = {} as HookApi;

function beforeTool() {
  const extension = createToolPolicyExtension({ effects });
  const registration = extension.hooks?.[0];
  expect(registration?.task).toBe("pi.tool");
  const handler = (registration?.handlers as Partial<ToolHooks> | undefined)?.beforeTool;
  if (!handler) throw new Error("Expected Pi tool policy beforeTool hook");
  return handler;
}

function beforeToolWithDelegates(delegates: readonly PiToolPolicyDelegate[]) {
  const extension = createToolPolicyExtension({ effects, delegates });
  const handler = (extension.hooks?.[0]?.handlers as Partial<ToolHooks> | undefined)?.beforeTool;
  if (!handler) throw new Error("Expected Pi tool policy beforeTool hook");
  return handler;
}

function afterTool(delegates: readonly PiToolPolicyDelegate[], hookApi: HookApi = api) {
  const extension = createToolPolicyExtension({ effects, delegates });
  const registration = extension.hooks?.[0];
  const handler = (registration?.handlers as Partial<ToolHooks> | undefined)?.afterTool;
  if (!handler) throw new Error("Expected Pi tool policy afterTool hook");
  return { handler, hookApi };
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

describe("createToolPolicyExtension", () => {
  it("refuses the turn when the action ceiling is reached", async () => {
    // The ceiling is the harness's own wall: a harness with no sandbox has no
    // other bound on a runaway turn, so the count is the wall.
    const ceiling = createFixedActionCeiling(1);
    const extension = createToolPolicyExtension({ effects, ceiling: () => ceiling });
    const handler = (extension.hooks?.[0]?.handlers as Partial<ToolHooks> | undefined)?.beforeTool;
    if (!handler) throw new Error("Expected the tool policy beforeTool hook");

    await expect(handler(call("model_tool"), api, context)).resolves.toBeUndefined();
    await expect(handler(call("model_tool"), api, context)).resolves.toEqual({
      block: "This turn has reached the action ceiling",
    });
  });

  it("authorizes model calls only when the exact registry declares the model caller", async () => {
    const hook = beforeTool();

    await expect(hook(call("model_tool"), api, context)).resolves.toBeUndefined();
    await expect(hook(call("nested_tool"), api, context)).resolves.toEqual({
      block: "Tool caller is not allowed: model -> nested_tool",
    });
  });

  it("authorizes nested calls only when the exact registry declares the tools caller", async () => {
    const hook = beforeTool();

    await expect(hook(call("nested_tool", true), api, context)).resolves.toBeUndefined();
    await expect(hook(call("model_tool", true), api, context)).resolves.toEqual({
      block: "Tool caller is not allowed: tools -> model_tool",
    });
  });

  it("default-denies undeclared model and nested tools", async () => {
    const hook = beforeTool();

    await expect(hook(call("unknown"), api, context)).resolves.toEqual({
      block: "Tool is not declared: unknown",
    });
    await expect(hook(call("unknown", true), api, context)).resolves.toEqual({
      block: "Tool is not declared: unknown",
    });
  });

  it("composes workspace and external-action delegates in one policy", async () => {
    const workspace = vi.fn(async () => undefined);
    const externalAction = vi.fn(async () => undefined);
    const hook = beforeToolWithDelegates([
      { beforeTool: workspace },
      { beforeTool: externalAction },
    ]);

    await expect(hook(call("model_tool"), api, context)).resolves.toBeUndefined();
    expect(workspace).toHaveBeenCalledOnce();
    expect(externalAction).toHaveBeenCalledOnce();
  });

  it("runs broad emergency denial before delegates and memos only the final allow", async () => {
    const order: string[] = [];
    const emergency: PiToolEmergencyPolicy = {
      beforeFeatureDelegates: vi.fn(async () => {
        order.push("emergency");
        return undefined;
      }),
    };
    const delegate: PiToolPolicyDelegate = {
      beforeTool: vi.fn(async () => {
        order.push("delegate");
        return undefined;
      }),
    };
    const extension = createToolPolicyExtension({
      effects,
      delegates: [delegate],
      emergencyPolicy: emergency,
    });
    const hook = (extension.hooks?.[0]?.handlers as Partial<ToolHooks>).beforeTool!;

    await expect(hook(call("model_tool"), api, context)).resolves.toBeUndefined();
    expect(order).toEqual(["emergency", "delegate"]);
  });

  it("does not write a feature allow memo when a later delegate denies", async () => {
    const memoFinalAllow = vi.fn(async () => undefined);
    const extension = createToolPolicyExtension({
      effects,
      delegates: [
        { beforeTool: async () => undefined, memoFinalAllow },
        { beforeTool: async () => ({ block: "later denial" }) },
      ],
    });
    const hook = (extension.hooks?.[0]?.handlers as Partial<ToolHooks>).beforeTool!;

    await expect(hook(call("model_tool"), api, context)).resolves.toEqual({
      block: "later denial",
    });
    expect(memoFinalAllow).not.toHaveBeenCalled();
  });

  it("replaces a successful-looking result when any afterTool delegate throws", async () => {
    const original: ToolExecutionResult = { output: [{ type: "text", text: "published" }] };
    const { handler, hookApi } = afterTool([
      {
        afterTool: async () => {
          throw new Error("policy backend unavailable");
        },
      },
    ]);

    await expect(handler(call("model_tool"), original, hookApi, context)).resolves.toEqual({
      isError: true,
      output: [{ type: "text", text: "Tool policy failed closed" }],
    });
  });

  it("fails closed when a delegate's api.memo operation rejects", async () => {
    const original: ToolExecutionResult = { output: [{ type: "text", text: "published" }] };
    const rejectingApi = {
      memo: vi.fn(async () => {
        throw new Error("memo unavailable");
      }),
    } as unknown as HookApi;
    const { handler } = afterTool(
      [
        {
          afterTool: async (_call, _declaration, result, delegateApi, delegateContext) => {
            await delegateApi.memo("external-action", delegateContext);
            return result;
          },
        },
      ],
      rejectingApi
    );

    await expect(handler(call("model_tool"), original, rejectingApi, context)).resolves.toEqual({
      isError: true,
      output: [{ type: "text", text: "Tool policy failed closed" }],
    });
  });

  it("does not convert an abort into a policy result", async () => {
    const abort = new DOMException("cancelled", "AbortError");
    const original: ToolExecutionResult = { output: [{ type: "text", text: "published" }] };
    const { handler, hookApi } = afterTool([
      {
        afterTool: async () => {
          throw abort;
        },
      },
    ]);

    await expect(handler(call("model_tool"), original, hookApi, context)).rejects.toBe(abort);
  });
});
