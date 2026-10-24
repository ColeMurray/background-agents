import { describe, expect, it, vi } from "vitest";
import { PI_MEMORY_TOOL_EFFECT_REGISTRATIONS } from "@open-inspect/shared";
import { createMemoryPolicyDelegate, MEMORY_OWNED_TOOL_NAMES } from "./memory-policy-extension";
import { PI_MEMORY_TOOL_NAMES } from "./memory-extension";

const writeDeclaration = PI_MEMORY_TOOL_EFFECT_REGISTRATIONS.find(
  (registration) => registration.name === PI_MEMORY_TOOL_NAMES.write
);
if (!writeDeclaration) throw new Error("The write tool has no effect declaration");

const readDeclaration = PI_MEMORY_TOOL_EFFECT_REGISTRATIONS.find(
  (registration) => registration.name === PI_MEMORY_TOOL_NAMES.read
);
if (!readDeclaration) throw new Error("The read tool has no effect declaration");

const writeArguments = {
  memoryType: "fact",
  title: "Deploy window",
  description: "Deploys happen on Tuesdays",
  content: "Tuesdays only",
  scopeType: "repository",
};

const api = { callId: "call-1", taskId: 7, conversationId: "conversation-1" } as never;
const context = { abortSignal: undefined } as never;

function call(name: string, arguments_: Record<string, unknown>) {
  return { name, arguments: arguments_ } as never;
}

describe("memory policy delegate", () => {
  it("owns the write tool, and only the write tool", () => {
    expect(MEMORY_OWNED_TOOL_NAMES).toEqual([PI_MEMORY_TOOL_NAMES.write]);
  });

  it("asks the owning session and lets an allowed write through", async () => {
    const authorize = vi.fn(async () => ({ allowed: true }));
    const delegate = createMemoryPolicyDelegate({ client: { authorize } });

    const decision = await delegate.beforeTool?.(
      call(PI_MEMORY_TOOL_NAMES.write, writeArguments),
      writeDeclaration,
      api,
      context
    );

    expect(decision).toBeUndefined();
    expect(authorize).toHaveBeenCalledWith(writeArguments, undefined);
  });

  it("refuses the write with the session's own reason", async () => {
    const delegate = createMemoryPolicyDelegate({
      client: {
        authorize: async () => ({
          allowed: false,
          reason: "Memory scope is outside this session",
        }),
      },
    });

    const decision = await delegate.beforeTool?.(
      call(PI_MEMORY_TOOL_NAMES.write, writeArguments),
      writeDeclaration,
      api,
      context
    );

    expect(decision).toEqual({ block: "Memory scope is outside this session" });
  });

  it("fails closed when the session cannot answer", async () => {
    const delegate = createMemoryPolicyDelegate({
      client: {
        authorize: async () => {
          throw new Error("the session runtime is unreachable");
        },
      },
    });

    const decision = await delegate.beforeTool?.(
      call(PI_MEMORY_TOOL_NAMES.write, writeArguments),
      writeDeclaration,
      api,
      context
    );

    expect(decision?.block).toContain("could not be authorized");
    expect(decision?.block).not.toContain("unreachable");
  });

  it("leaves the reads to the session's own authorization", async () => {
    const authorize = vi.fn(async () => ({ allowed: true }));
    const delegate = createMemoryPolicyDelegate({ client: { authorize } });

    const decision = await delegate.beforeTool?.(
      call(PI_MEMORY_TOOL_NAMES.read, { memoryId: "mem_1" }),
      readDeclaration,
      api,
      context
    );

    expect(decision).toBeUndefined();
    expect(authorize).not.toHaveBeenCalled();
  });

  it("leaves a malformed write to the tool's own validation", async () => {
    const authorize = vi.fn(async () => ({ allowed: true }));
    const delegate = createMemoryPolicyDelegate({ client: { authorize } });

    const decision = await delegate.beforeTool?.(
      call(PI_MEMORY_TOOL_NAMES.write, { title: "no scope" }),
      writeDeclaration,
      api,
      context
    );

    expect(decision).toBeUndefined();
    expect(authorize).not.toHaveBeenCalled();
  });
});
