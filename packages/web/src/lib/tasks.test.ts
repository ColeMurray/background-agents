import { describe, expect, it } from "vitest";

import { extractLatestTasks } from "./tasks";
import type { SandboxEvent } from "@/types/session";

type ToolCallEvent = Extract<SandboxEvent, { type: "tool_call" }>;

function makeToolCall(overrides: Partial<ToolCallEvent> = {}): ToolCallEvent {
  return {
    type: "tool_call",
    tool: "TodoWrite",
    args: {},
    callId: "call-1",
    messageId: "msg-1",
    sandboxId: "sandbox-1",
    status: "completed",
    timestamp: 1000,
    ...overrides,
  };
}

describe("extractLatestTasks", () => {
  describe("with no events", () => {
    it("returns empty array for empty events", () => {
      expect(extractLatestTasks([])).toEqual([]);
    });

    it("returns empty array when there are no tool_call events", () => {
      const events: SandboxEvent[] = [
        {
          type: "token",
          content: "hello",
          messageId: "msg-1",
          sandboxId: "sandbox-1",
          timestamp: 1000,
        },
      ];
      expect(extractLatestTasks(events)).toEqual([]);
    });
  });

  describe("TodoWrite extraction", () => {
    it("extracts tasks from a TodoWrite event", () => {
      const events = [
        makeToolCall({
          tool: "TodoWrite",
          args: {
            todos: [
              { content: "Task A", status: "pending" },
              { content: "Task B", status: "in_progress" },
              { content: "Task C", status: "completed" },
            ],
          },
        }),
      ];
      expect(extractLatestTasks(events)).toEqual([
        { content: "Task A", status: "pending", activeForm: undefined },
        { content: "Task B", status: "in_progress", activeForm: undefined },
        { content: "Task C", status: "completed", activeForm: undefined },
      ]);
    });

    it("uses only the latest TodoWrite event when multiple exist", () => {
      const events = [
        makeToolCall({
          tool: "TodoWrite",
          timestamp: 1000,
          args: {
            todos: [{ content: "Old Task", status: "pending" }],
          },
        }),
        makeToolCall({
          tool: "TodoWrite",
          timestamp: 2000,
          args: {
            todos: [{ content: "New Task", status: "completed" }],
          },
        }),
      ];
      const result = extractLatestTasks(events);
      expect(result).toHaveLength(1);
      expect(result[0].content).toBe("New Task");
    });

    it("handles TodoWrite with case-insensitive tool name", () => {
      const events = [
        makeToolCall({
          tool: "todowrite",
          args: {
            todos: [{ content: "Lowercase Tool", status: "pending" }],
          },
        }),
      ];
      expect(extractLatestTasks(events)).toHaveLength(1);
      expect(extractLatestTasks(events)[0].content).toBe("Lowercase Tool");
    });

    it("handles TODOWRITE uppercase tool name", () => {
      const events = [
        makeToolCall({
          tool: "TODOWRITE",
          args: {
            todos: [{ content: "Uppercase Tool", status: "pending" }],
          },
        }),
      ];
      expect(extractLatestTasks(events)).toHaveLength(1);
    });

    it("returns empty array when TodoWrite args has no todos", () => {
      const events = [
        makeToolCall({
          tool: "TodoWrite",
          args: {},
        }),
      ];
      expect(extractLatestTasks(events)).toEqual([]);
    });

    it("returns empty array when TodoWrite todos is not an array", () => {
      const events = [
        makeToolCall({
          tool: "TodoWrite",
          args: { todos: "not-an-array" },
        }),
      ];
      expect(extractLatestTasks(events)).toEqual([]);
    });

    it("returns empty array when TodoWrite args is undefined", () => {
      const events = [
        makeToolCall({
          tool: "TodoWrite",
          args: undefined,
        }),
      ];
      expect(extractLatestTasks(events)).toEqual([]);
    });

    it("defaults content to empty string when todo.content is falsy", () => {
      const events = [
        makeToolCall({
          tool: "TodoWrite",
          args: {
            todos: [{ content: "", status: "pending" }],
          },
        }),
      ];
      expect(extractLatestTasks(events)[0].content).toBe("");
    });

    it("defaults status to pending when todo.status is falsy", () => {
      const events = [
        makeToolCall({
          tool: "TodoWrite",
          args: {
            todos: [{ content: "Task", status: undefined }],
          },
        }),
      ];
      expect(extractLatestTasks(events)[0].status).toBe("pending");
    });

    it("preserves activeForm when present", () => {
      const events = [
        makeToolCall({
          tool: "TodoWrite",
          args: {
            todos: [
              { content: "Running task", status: "in_progress", activeForm: "Working on it..." },
            ],
          },
        }),
      ];
      expect(extractLatestTasks(events)[0].activeForm).toBe("Working on it...");
    });
  });

  describe("Agent/Task tool extraction", () => {
    it("extracts tasks from task tool calls", () => {
      const events = [
        makeToolCall({
          tool: "task",
          callId: "task-1",
          args: { description: "Run tests", prompt: "run npm test" },
          status: "completed",
        }),
      ];
      const result = extractLatestTasks(events);
      expect(result).toHaveLength(1);
      expect(result[0].content).toBe("Run tests");
      expect(result[0].status).toBe("completed");
    });

    it("uses prompt when description is missing", () => {
      const events = [
        makeToolCall({
          tool: "task",
          callId: "task-1",
          args: { prompt: "Fix the bug" },
          status: "running",
        }),
      ];
      const result = extractLatestTasks(events);
      expect(result[0].content).toBe("Fix the bug");
      expect(result[0].status).toBe("in_progress");
    });

    it("falls back to 'Task' when neither description nor prompt is a string", () => {
      const events = [
        makeToolCall({
          tool: "task",
          callId: "task-1",
          args: {},
          status: "running",
        }),
      ];
      expect(extractLatestTasks(events)[0].content).toBe("Task");
    });

    it("maps running status to in_progress", () => {
      const events = [
        makeToolCall({
          tool: "task",
          callId: "task-1",
          args: { description: "Work" },
          status: "running",
        }),
      ];
      expect(extractLatestTasks(events)[0].status).toBe("in_progress");
    });

    it("maps completed status to completed", () => {
      const events = [
        makeToolCall({
          tool: "task",
          callId: "task-1",
          args: { description: "Work" },
          status: "completed",
        }),
      ];
      expect(extractLatestTasks(events)[0].status).toBe("completed");
    });

    it("maps unknown status to pending", () => {
      const events = [
        makeToolCall({
          tool: "task",
          callId: "task-1",
          args: { description: "Work" },
          status: "error",
        }),
      ];
      expect(extractLatestTasks(events)[0].status).toBe("pending");
    });

    it("uses latest event for the same callId when status transitions", () => {
      const events = [
        makeToolCall({
          tool: "task",
          callId: "task-1",
          args: { description: "Work" },
          status: "running",
          timestamp: 1000,
        }),
        makeToolCall({
          tool: "task",
          callId: "task-1",
          args: { description: "Work" },
          status: "completed",
          timestamp: 2000,
        }),
      ];
      const result = extractLatestTasks(events);
      expect(result).toHaveLength(1);
      expect(result[0].status).toBe("completed");
    });

    it("preserves insertion order for multiple unique task callIds", () => {
      const events = [
        makeToolCall({
          tool: "task",
          callId: "task-1",
          args: { description: "First" },
          timestamp: 1000,
        }),
        makeToolCall({
          tool: "task",
          callId: "task-2",
          args: { description: "Second" },
          timestamp: 2000,
        }),
        makeToolCall({
          tool: "task",
          callId: "task-3",
          args: { description: "Third" },
          timestamp: 3000,
        }),
      ];
      const result = extractLatestTasks(events);
      expect(result.map((t) => t.content)).toEqual(["First", "Second", "Third"]);
    });

    it("handles case-insensitive 'Task' tool name", () => {
      const events = [
        makeToolCall({
          tool: "Task",
          callId: "task-1",
          args: { description: "Mixed case" },
        }),
        makeToolCall({
          tool: "TASK",
          callId: "task-2",
          args: { description: "Uppercase" },
        }),
      ];
      expect(extractLatestTasks(events)).toHaveLength(2);
    });

    it("returns empty array when there are no task events", () => {
      const events = [
        makeToolCall({ tool: "Bash", args: { command: "ls" } }),
        makeToolCall({ tool: "Read", args: { filePath: "src/index.ts" } }),
      ];
      expect(extractLatestTasks(events)).toEqual([]);
    });
  });

  describe("merge: TodoWrite + task tool", () => {
    it("merges TodoWrite tasks first then agent tasks", () => {
      const events = [
        makeToolCall({
          tool: "TodoWrite",
          callId: "todo-1",
          timestamp: 1000,
          args: {
            todos: [
              { content: "Todo A", status: "pending" },
              { content: "Todo B", status: "completed" },
            ],
          },
        }),
        makeToolCall({
          tool: "task",
          callId: "agent-1",
          timestamp: 2000,
          args: { description: "Sub-agent task" },
          status: "running",
        }),
      ];
      const result = extractLatestTasks(events);
      expect(result).toHaveLength(3);
      expect(result[0].content).toBe("Todo A");
      expect(result[1].content).toBe("Todo B");
      expect(result[2].content).toBe("Sub-agent task");
    });

    it("returns only TodoWrite tasks when no task events exist", () => {
      const events = [
        makeToolCall({
          tool: "TodoWrite",
          args: {
            todos: [{ content: "Only todo", status: "in_progress" }],
          },
        }),
      ];
      const result = extractLatestTasks(events);
      expect(result).toHaveLength(1);
      expect(result[0].content).toBe("Only todo");
    });

    it("returns only agent tasks when no TodoWrite events exist", () => {
      const events = [
        makeToolCall({
          tool: "task",
          callId: "task-1",
          args: { description: "Only agent task" },
          status: "completed",
        }),
      ];
      const result = extractLatestTasks(events);
      expect(result).toHaveLength(1);
      expect(result[0].content).toBe("Only agent task");
    });

    it("ignores non-task tool calls in the merge", () => {
      const events = [
        makeToolCall({ tool: "Bash", args: { command: "npm test" } }),
        makeToolCall({ tool: "Read", args: { filePath: "src/app.ts" } }),
        makeToolCall({
          tool: "TodoWrite",
          args: { todos: [{ content: "Real task", status: "pending" }] },
        }),
      ];
      const result = extractLatestTasks(events);
      expect(result).toHaveLength(1);
      expect(result[0].content).toBe("Real task");
    });
  });
});
