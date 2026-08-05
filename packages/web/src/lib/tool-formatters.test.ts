import { describe, expect, it } from "vitest";
import type { SandboxEvent } from "@/types/session";
import { formatToolCall } from "./tool-formatters";

type ToolCallEvent = Extract<SandboxEvent, { type: "tool_call" }>;

function toolCall(tool: string, args: Record<string, unknown>): ToolCallEvent {
  return {
    type: "tool_call",
    tool,
    args,
    callId: "call-1",
    messageId: "message-1",
    sandboxId: "sandbox-1",
    timestamp: 1,
  };
}

describe("formatToolCall child session tools", () => {
  it("formats get-child-status with its child ID", () => {
    expect(formatToolCall(toolCall("get-child-status", { childId: "child-123" }))).toMatchObject({
      toolName: "Child Status",
      summary: "child-123",
    });
  });

  it("formats persisted get-task-status calls as child status", () => {
    expect(formatToolCall(toolCall("get-task-status", { taskId: "child-legacy" }))).toMatchObject({
      toolName: "Child Status",
      summary: "child-legacy",
    });
  });
});
