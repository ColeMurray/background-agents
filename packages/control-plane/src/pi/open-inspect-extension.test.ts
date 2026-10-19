import { describe, expect, it, vi } from "vitest";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import {
  createAgentMessagingExtension,
  createOpenInspectExtension,
  createSubagentExtension,
} from "./open-inspect-extension";
import type { PiAgentControlRequest } from "./open-inspect-extension";

describe("createOpenInspectExtension", () => {
  it("offers replay-safe repository tools only when the session has repositories", async () => {
    const invokeRepository = vi.fn(async () => ({ entries: [] }));
    const extension = createOpenInspectExtension({
      repositories: [
        {
          repoOwner: "acme",
          repoName: "widgets",
          position: 0,
          baseBranch: "main",
        },
      ],
      invokeRepository,
    });

    expect(extension.tools?.map((tool) => [tool.name, tool.replay])).toEqual([
      ["repository_list", "safe"],
      ["repository_read", "safe"],
    ]);
    expect(extension.tools?.map((tool) => tool.callers)).toEqual([
      ["model", "tools"],
      ["model", "tools"],
    ]);
    expect(extension.sections?.[0]?.render({} as never, {} as never)).not.toContain("Delegate");

    const list = extension.tools?.find((tool) => tool.name === "repository_list");
    const result = await list?.execute({ path: "src" }, { taskId: 17 } as ToolExecutionApi, {
      abortSignal: undefined,
      value: () => undefined,
      toString: () => "test",
    });
    expect(invokeRepository).toHaveBeenCalledWith("repository_list", { path: "src" }, undefined);
    expect(result).toMatchObject({ structuredOutput: { entries: [] } });
  });

  it("keeps repository-less sessions free of repository tools", () => {
    const extension = createOpenInspectExtension({
      repositories: [],
      invokeRepository: vi.fn(),
    });
    expect(extension.tools?.map((tool) => tool.name)).toEqual([]);
  });

  it("packages subagents separately so children retain the core Open-Inspect extension", () => {
    const extension = createSubagentExtension();
    expect(extension.name).toBe("open-inspect.subagent");
    expect(extension.tools?.map((tool) => [tool.name, tool.replay])).toEqual([
      ["subagent", "safe"],
    ]);
    expect(extension.tools?.[0]?.callers).toEqual(["model"]);
    expect(extension.sections?.[0]?.render({} as never, {} as never)).toContain(
      "Delegate independent analysis"
    );
  });

  it("rejects a fifth active same-session subagent before creating its conversation", async () => {
    const extension = createSubagentExtension();
    const tool = extension.tools?.find((candidate) => candidate.name === "subagent");
    if (!tool) throw new Error("Expected subagent tool");
    const createConversation = vi.fn();
    const api = {
      taskId: 99,
      agent: vi.fn(async () => ({ extensions: [extension] })),
      commit: vi.fn(async (change) =>
        change({
          scanConversations: vi
            .fn()
            .mockResolvedValueOnce({ items: [] })
            .mockResolvedValueOnce({
              items: Array.from({ length: 4 }, (_, index) => ({
                id: index + 1,
                owner: { conversationId: 1, taskId: index + 10 },
              })),
            }),
          task: vi.fn(async () => ({ state: { status: "running", phase: "run" } })),
          createConversation,
        })
      ),
    };
    await expect(
      tool.execute({ task: "bounded work" }, api as unknown as ToolExecutionApi, {
        abortSignal: undefined,
        value: () => undefined,
        toString: () => "test",
      })
    ).rejects.toThrow("Pi active subagent limit reached");
    expect(createConversation).not.toHaveBeenCalled();
  });

  it("gives same-session agent controls stable idempotency keys", async () => {
    const invoke = vi.fn(async (_control: PiAgentControlRequest, _conversationId: number) => ({
      ok: true,
    }));
    const extension = createAgentMessagingExtension({ invoke });
    expect(extension.tools?.map((tool) => tool.name)).toEqual([
      "list_agents",
      "send_agent_message",
      "get_last_message",
      "follow_up_agent",
      "steer_agent",
      "cancel_agent",
      "inspect_agents",
    ]);
    const steer = extension.tools?.find((tool) => tool.name === "steer_agent");
    if (!steer) throw new Error("Expected steer_agent tool");
    const api = { taskId: 7, callId: "call-1", conversationId: 1 } as ToolExecutionApi;
    const context = { abortSignal: undefined, value: () => undefined, toString: () => "test" };
    await steer.execute({ conversationId: 2, content: "focus" }, api, context);
    await steer.execute({ conversationId: 2, content: "focus" }, api, context);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[0]?.[0]).toEqual(invoke.mock.calls[1]?.[0]);
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({
      action: "steer",
      conversationId: 2,
      content: "focus",
      requestId: expect.stringMatching(/^agent:[0-9a-f]{64}$/),
    });
    expect(invoke.mock.calls[0]?.[1]).toBe(1);
  });
});
