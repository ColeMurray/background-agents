import { describe, expect, it, vi } from "vitest";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createSandboxExecutionExtension,
  createSandboxExecutionPolicyDelegate,
  type SandboxExecutionToolRequest,
} from "./sandbox-execution-extension";

function api() {
  const memos = new Map<string, unknown>([
    [
      "sandbox-execution-approval-v1",
      { revision: 1, effect: "sandbox_execution", purpose: "test" },
    ],
  ]);
  return {
    taskId: 7,
    callId: "call-1",
    memo: vi.fn(async (name: string, ...args: unknown[]) => {
      const candidate = args.length === 2 ? args[0] : undefined;
      if (candidate !== undefined && !memos.has(name)) memos.set(name, candidate);
      return memos.get(name);
    }),
  } as unknown as ToolExecutionApi;
}

const context = BACKGROUND_CONTEXT;

describe("sandbox execution Pi extension", () => {
  it("registers model-only shell, build, and test tools with identical authority", () => {
    const extension = createSandboxExecutionExtension({ invoke: vi.fn() });
    expect(
      extension.tools?.map(({ name, callers, replay }) => ({ name, callers, replay }))
    ).toEqual(
      ["run_shell", "run_build", "run_tests"].map((name) => ({
        name,
        callers: ["model"],
        replay: "safe",
      }))
    );
  });

  it("uses one stable command id across duplicate durable tool replay", async () => {
    const requests: SandboxExecutionToolRequest[] = [];
    const invoke = vi.fn(async (request: SandboxExecutionToolRequest) => {
      requests.push(request);
      if (request.action === "status") {
        return {
          command: {
            id: request.commandId,
            state: "succeeded",
            outputTruncated: false,
            exitCode: 0,
            signal: null,
            error: null,
          },
          chunks: [],
          nextSequence: null,
        };
      }
      return {};
    });
    const extension = createSandboxExecutionExtension({ invoke });
    const tool = extension.tools?.find(({ name }) => name === "run_tests");
    if (!tool) throw new Error("run_tests tool missing");
    const executionApi = api();

    await tool.execute({ argv: ["npm", "test"] }, executionApi, context);
    await tool.execute({ argv: ["npm", "test"] }, executionApi, context);

    const submissions = requests.filter(
      (request): request is Extract<SandboxExecutionToolRequest, { action: "submit" }> =>
        request.action === "submit"
    );
    expect(submissions).toHaveLength(2);
    expect(new Set(submissions.map(({ command }) => command.commandId))).toHaveLength(1);
    expect(submissions[0]?.command.commandId).toMatch(/^exec_[a-f0-9]{64}$/);
  });

  it("memos the same approval revision for every execution purpose", async () => {
    const delegate = createSandboxExecutionPolicyDelegate();
    for (const name of ["run_shell", "run_build", "run_tests"] as const) {
      const hookApi = api();
      await delegate.memoFinalAllow?.(
        { type: "toolCall", id: "call-1", name, arguments: {} },
        { name, effect: "sandbox_execution", callers: ["model"], replay: "safe" },
        hookApi,
        context
      );
      expect(hookApi.memo).toHaveBeenCalledWith(
        "sandbox-execution-approval-v1",
        expect.objectContaining({ revision: 1 }),
        context
      );
    }
  });

  it("cancels the exact command when the tool aborts", async () => {
    const controller = new AbortController();
    const invoke = vi.fn(async (request: SandboxExecutionToolRequest) => {
      if (request.action === "status") {
        controller.abort(new DOMException("cancelled", "AbortError"));
        return {
          command: {
            id: request.commandId,
            state: "running",
            outputTruncated: false,
            exitCode: null,
            signal: null,
            error: null,
          },
          chunks: [],
          nextSequence: null,
        };
      }
      return {};
    });
    const tool = createSandboxExecutionExtension({ invoke }).tools?.find(
      ({ name }) => name === "run_shell"
    );
    if (!tool) throw new Error("run_shell tool missing");

    await expect(
      tool.execute({ argv: ["sleep", "60"] }, api(), { ...context, abortSignal: controller.signal })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(invoke).toHaveBeenCalledWith({
      action: "cancel",
      commandId: expect.stringMatching(/^exec_[a-f0-9]{64}$/),
    });
  });
});
