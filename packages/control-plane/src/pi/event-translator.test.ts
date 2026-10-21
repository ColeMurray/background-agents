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
    ).toEqual([expect.objectContaining({ type: "token", content: "Hello", partId: "message-1" })]);
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
        output: "[redacted]",
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
          id: 42,
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

  it("keeps a read's content out of the shared timeline", () => {
    const state = { text: "" };
    const events = [
      {
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "read",
        taskId: 2,
        args: { path: "/workspace/scratch/secret.txt" },
      },
      {
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "read",
        taskId: 2,
        entry: {
          id: 42,
          model: [
            {
              role: "toolResult",
              toolCallId: "call-1",
              toolName: "read",
              content: [{ type: "text", text: "the secret value" }],
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

    // The timeline is visible to every collaborator, so a read keeps its
    // shape and not its content.
    expect(translated).toEqual([
      expect.objectContaining({ type: "tool_call", status: "running" }),
      expect.objectContaining({ type: "tool_call", output: "[redacted]", status: "completed" }),
    ]);
    expect(JSON.stringify(translated)).not.toContain("the secret value");
  });

  it("keeps a memory body out of the shared timeline", () => {
    const state = { text: "" };
    const events = [
      {
        type: "tool_execution_start",
        toolCallId: "read-1",
        toolName: "memory_read",
        taskId: 2,
        args: { memoryId: "mem_1" },
      },
      {
        type: "tool_execution_end",
        toolCallId: "read-1",
        toolName: "memory_read",
        taskId: 2,
        entry: {
          id: 42,
          model: [
            {
              role: "toolResult",
              toolCallId: "read-1",
              toolName: "memory_read",
              content: [{ type: "text", text: "the owner's private note" }],
              isError: false,
            },
          ],
        },
      },
      {
        type: "tool_execution_start",
        toolCallId: "write-1",
        toolName: "memory_write",
        taskId: 3,
        args: {
          memoryType: "fact",
          title: "Deploy window",
          description: "Deploys happen on Tuesdays",
          content: "the owner's private note",
          scopeType: "personal",
        },
      },
      {
        type: "tool_execution_end",
        toolCallId: "write-1",
        toolName: "memory_write",
        taskId: 3,
        entry: {
          id: 43,
          model: [
            {
              role: "toolResult",
              toolCallId: "write-1",
              toolName: "memory_write",
              content: [{ type: "text", text: "the owner's private note" }],
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
    const serialized = JSON.stringify(translated);

    // The timeline is visible to every collaborator, so a memory body stays
    // with the model and the timeline keeps the shape.
    expect(serialized).not.toContain("the owner's private note");
    expect(translated).toEqual([
      expect.objectContaining({ tool: "memory_read", status: "running" }),
      expect.objectContaining({ tool: "memory_read", output: "[redacted]", status: "completed" }),
      expect.objectContaining({
        tool: "memory_write",
        args: {
          memoryType: "fact",
          title: "Deploy window",
          description: "Deploys happen on Tuesdays",
          content: "[redacted]",
          scopeType: "personal",
        },
        status: "running",
      }),
      expect.objectContaining({ tool: "memory_write", output: "[redacted]", status: "completed" }),
    ]);
  });

  it("projects model usage when an assistant message is committed", () => {
    const state = { text: "" };
    const events = [
      {
        type: "message_end",
        entry: {
          id: 42,
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
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "step_start", stepId: "pi-entry:42" }),
        expect.objectContaining({
          type: "step_finish",
          stepId: "pi-entry:42",
          tokens: {
            input: 10,
            output: 4,
            reasoning: 2,
            cache: { read: 3, write: 1 },
            total: 20,
          },
          reason: "stop",
        }),
      ])
    );
  });

  it("reconstructs the final tool result from a settled operation snapshot", () => {
    const snapshot = {
      type: "snapshot",
      entries: [
        { id: 10, model: [{ role: "user", content: [{ type: "text", text: "question" }] }] },
        {
          id: 11,
          model: [
            {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  id: "call-final",
                  name: "repository_read",
                  arguments: { path: "README.md" },
                },
              ],
              stopReason: "toolUse",
              usage: {
                input: 2,
                output: 1,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 3,
              },
            },
          ],
        },
        {
          id: 12,
          model: [
            {
              role: "toolResult",
              toolCallId: "call-final",
              toolName: "repository_read",
              content: [{ type: "text", text: "contents" }],
              isError: false,
            },
          ],
        },
      ],
      tools: [],
      nestedTools: [],
      compactions: [],
      inbox: [],
      agent: {},
      usage: { models: {}, tools: {} },
    } as unknown as AgentEvent;

    expect(
      translatePiEvents(
        [snapshot],
        { text: "" },
        {
          sessionId: "session-1",
          operationId: "message-1",
          timestamp: 131,
        }
      )
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool_call",
          callId: "call-final",
          status: "completed",
          output: "[redacted]",
        }),
      ])
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

  it("redacts writable workspace contents and edit diffs from projected events", () => {
    const events = [
      {
        type: "tool_execution_start",
        toolCallId: "write-1",
        toolName: "write",
        taskId: 2,
        args: { path: "draft.txt", content: "super-secret-write" },
      },
      {
        type: "tool_execution_start",
        toolCallId: "edit-1",
        toolName: "edit",
        taskId: 3,
        args: {
          path: "draft.txt",
          edits: [{ oldText: "super-secret-old", newText: "super-secret-new" }],
        },
      },
      {
        type: "tool_execution_update",
        toolCallId: "edit-1",
        toolName: "edit",
        taskId: 3,
        output: { set: "@@ -1 +1 @@\n-super-secret-old\n+super-secret-new" },
      },
    ] as unknown as AgentEvent[];

    const translated = translatePiEvents(
      events,
      { text: "" },
      {
        sessionId: "session-1",
        operationId: "message-1",
        timestamp: 129,
      }
    );
    const serialized = JSON.stringify(translated);

    expect(serialized).not.toContain("super-secret");
    expect(translated).toEqual([
      expect.objectContaining({
        tool: "write",
        args: { path: "draft.txt", content: "[redacted]" },
      }),
      expect.objectContaining({
        tool: "edit",
        args: {
          path: "draft.txt",
          edits: [{ oldText: "[redacted]", newText: "[redacted]" }],
        },
      }),
      expect.objectContaining({ tool: "edit", output: "[redacted]" }),
    ]);
  });

  it("redacts recovered snapshot and nested workspace mutation data", () => {
    const snapshot = {
      type: "snapshot",
      entries: [],
      run: { inputs: [1] },
      generation: {
        attempt: 1,
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "write-snapshot",
              name: "write",
              arguments: { path: "snapshot.txt", content: "snapshot-secret" },
            },
          ],
        },
      },
      tools: [
        {
          callId: "write-snapshot",
          name: "write",
          status: "running",
          taskId: 2,
          output: "snapshot-secret-output",
        },
      ],
      nestedTools: [
        {
          callId: "edit-nested",
          parentCallId: "parent-1",
          name: "edit",
          status: "running",
          taskId: 3,
          arguments: {
            path: "snapshot.txt",
            edits: [{ oldText: "nested-secret-old", newText: "nested-secret-new" }],
          },
          output: "nested-secret-diff",
        },
      ],
      compactions: [],
      inbox: [],
      agent: {},
      usage: { models: {}, tools: {} },
    } as unknown as AgentEvent;

    const translated = translatePiEvents(
      [snapshot],
      { text: "" },
      {
        sessionId: "session-1",
        operationId: "message-1",
        timestamp: 130,
      }
    );

    expect(JSON.stringify(translated)).not.toContain("secret");
    expect(translated).toEqual([
      expect.objectContaining({
        tool: "write",
        args: { path: "snapshot.txt", content: "[redacted]" },
        output: "[redacted]",
      }),
      expect.objectContaining({
        tool: "edit",
        args: {
          path: "snapshot.txt",
          edits: [{ oldText: "[redacted]", newText: "[redacted]" }],
        },
        output: "[redacted]",
        isSubtask: true,
      }),
    ]);
  });

  it("projects Code Mode and nested activity under one canonical SessionDO operation", () => {
    const translated = translatePiEvents(
      [
        {
          type: "tool_execution_start",
          toolCallId: "codemode-1",
          toolName: "codemode",
          args: {
            code: "const sensitiveScriptSource = true; return await tools.read({ path: 'README.md' });",
          },
          taskId: 10,
        },
        {
          type: "tool_execution_start",
          toolCallId: "read-1",
          parentToolCallId: "codemode-1",
          toolName: "read",
          args: { path: "README.md" },
          taskId: 11,
          parentTaskId: 10,
        },
      ] as unknown as AgentEvent[],
      { text: "" },
      { sessionId: "session-1", operationId: "message-1", timestamp: 140 }
    );

    expect(translated).toEqual([
      expect.objectContaining({
        type: "tool_call",
        tool: "codemode",
        callId: "codemode-1",
        args: { code: "[redacted]" },
        messageId: "message-1",
        sandboxId: "pi:session-1",
      }),
      expect.objectContaining({
        type: "tool_call",
        tool: "read",
        callId: "read-1",
        messageId: "message-1",
        sandboxId: "pi:session-1",
        isSubtask: true,
        taskCallId: "codemode-1",
      }),
    ]);
    expect(JSON.stringify(translated)).not.toContain("sensitiveScriptSource");
  });
});
