import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@earendil-works/pi-durable";
import { translatePiEvents } from "./event-translator";

describe("translatePiEvents", () => {
  it("projects cumulative text and step activity", () => {
    const state = { text: "" };
    const events = [
      { type: "turn_start" },
      {
        type: "message_update",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        changes: [{ type: "text_delta", contentIndex: 0, delta: "Hello" }],
      },
    ] satisfies AgentEvent[];

    expect(
      translatePiEvents(events, state, {
        sessionId: "session-1",
        operationId: "message-1",
        timestamp: 123,
      })
    ).toEqual([
      expect.objectContaining({ type: "step_start", messageId: "message-1" }),
      expect.objectContaining({ type: "token", content: "Hello", partId: "message-1" }),
    ]);
  });

  it("continues cumulative text across committed batches", () => {
    const state = { text: "Hello" };
    const events = [
      {
        type: "message_update",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        changes: [{ type: "text_delta", contentIndex: 0, delta: " world" }],
      },
    ] satisfies AgentEvent[];

    expect(
      translatePiEvents(events, state, {
        sessionId: "session-1",
        operationId: "message-1",
        timestamp: 124,
      })
    ).toEqual([expect.objectContaining({ type: "token", content: "Hello world" })]);
  });

  it("rebuilds committed partial text and running tools from a recovery snapshot", () => {
    const state = { text: "stale" };
    const snapshot = {
      type: "snapshot",
      entries: [],
      run: { inputs: [1] },
      generation: {
        attempt: 1,
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Recovered" },
            { type: "toolCall", id: "call-1", name: "repository_read", arguments: { path: "a" } },
          ],
        },
      },
      tools: [
        {
          callId: "call-1",
          name: "repository_read",
          status: "running",
          taskId: 2,
          output: "reading",
        },
      ],
      nestedTools: [],
      compactions: [],
      inbox: [],
      agent: {},
      usage: { models: {}, tools: {} },
    } as unknown as AgentEvent;

    expect(
      translatePiEvents([snapshot], state, {
        sessionId: "session-1",
        operationId: "message-1",
        timestamp: 125,
      })
    ).toEqual([
      expect.objectContaining({ type: "token", content: "Recovered" }),
      expect.objectContaining({
        type: "tool_call",
        tool: "repository_read",
        callId: "call-1",
        args: { path: "a" },
        status: "running",
        output: "reading",
      }),
    ]);
  });

  it("does not project an earlier assistant entry when recovery precedes generation", () => {
    const state = { text: "" };
    const snapshot = {
      type: "snapshot",
      entries: [
        {
          kind: "pi.assistant",
          model: [{ role: "assistant", content: [{ type: "text", text: "old answer" }] }],
        },
      ],
      run: { inputs: [1] },
      tools: [],
      nestedTools: [],
      compactions: [],
      inbox: [],
      agent: {},
      usage: { models: {}, tools: {} },
    } as unknown as AgentEvent;
    expect(
      translatePiEvents([snapshot], state, {
        sessionId: "session-1",
        operationId: "message-2",
        timestamp: 125,
      })
    ).toEqual([]);
  });

  it("projects tool lifecycle snapshots with arguments and output", () => {
    const state = { text: "" };
    const events = [
      {
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "repository_list",
        taskId: 2,
        args: { path: "src" },
      },
      {
        type: "tool_execution_update",
        toolCallId: "call-1",
        toolName: "repository_list",
        taskId: 2,
        output: { set: "listed" },
      },
      {
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "repository_list",
        taskId: 2,
        entry: {
          model: [
            {
              role: "toolResult",
              toolCallId: "call-1",
              toolName: "repository_list",
              content: [{ type: "text", text: "listed" }],
              isError: false,
            },
          ],
        },
      },
    ] as unknown as AgentEvent[];

    const translated = translatePiEvents(events, state, {
      sessionId: "session-1",
      operationId: "message-1",
      timestamp: 126,
    });
    expect(translated).toEqual([
      expect.objectContaining({ type: "tool_call", args: { path: "src" }, status: "running" }),
      expect.objectContaining({ type: "tool_call", output: "listed", status: "running" }),
      expect.objectContaining({ type: "tool_call", output: "listed", status: "completed" }),
    ]);
  });

  it("projects model usage when an assistant message is committed", () => {
    const state = { text: "" };
    const events = [
      {
        type: "message_end",
        entry: {
          kind: "pi.assistant",
          model: [
            {
              role: "assistant",
              content: [{ type: "text", text: "done" }],
              stopReason: "stop",
              usage: {
                input: 10,
                output: 4,
                reasoning: 2,
                cacheRead: 3,
                cacheWrite: 1,
                totalTokens: 20,
              },
            },
          ],
        },
      },
    ] as unknown as AgentEvent[];

    expect(
      translatePiEvents(events, state, {
        sessionId: "session-1",
        operationId: "message-1",
        timestamp: 127,
      })
    ).toContainEqual(
      expect.objectContaining({
        type: "step_finish",
        tokens: {
          input: 10,
          output: 4,
          reasoning: 2,
          cache: { read: 3, write: 1 },
          total: 20,
        },
        reason: "stop",
      })
    );
  });

  it("marks nested and faulted tools failed when Pi has no successful result entry", () => {
    const events = [
      {
        type: "tool_execution_end",
        toolCallId: "nested-1",
        toolName: "remote_write",
        taskId: 3,
        parentToolCallId: "parent-1",
        parentTaskId: 2,
        result: { isError: true, diagnostics: [], taskId: 3 },
      },
      {
        type: "tool_execution_end",
        toolCallId: "faulted-1",
        toolName: "repository_read",
        taskId: 4,
      },
    ] as unknown as AgentEvent[];

    expect(
      translatePiEvents(
        events,
        { text: "" },
        {
          sessionId: "session-1",
          operationId: "message-1",
          timestamp: 128,
        }
      )
    ).toEqual([
      expect.objectContaining({ callId: "nested-1", status: "failed", isSubtask: true }),
      expect.objectContaining({ callId: "faulted-1", status: "failed" }),
    ]);
  });
});
