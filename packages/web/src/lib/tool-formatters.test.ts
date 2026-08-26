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

describe("formatToolCall summaries", () => {
  it("preserves complete commands in the collapsed summary", () => {
    const command = `PYTHONPATH=src uv run pytest ${"tests/very_long_directory/".repeat(4)}test_file.py`;

    expect(formatToolCall(toolCall("bash", { command })).summary).toBe(command);
  });

  it("preserves complete task descriptions and URLs", () => {
    const description = "Investigate the complete responsive timeline overflow behavior";
    const url = `https://example.com/${"deeply/nested/".repeat(5)}resource`;

    expect(formatToolCall(toolCall("task", { description })).summary).toBe(description);
    expect(formatToolCall(toolCall("webfetch", { url })).summary).toBe(url);
  });

  it("renders skill calls with the skill name", () => {
    expect(formatToolCall(toolCall("skill", { name: "visual-verification" }))).toMatchObject({
      toolName: "skill",
      summary: '"visual-verification"',
    });
  });

  it("does not render full task prompts or unknown-tool arguments in collapsed summaries", () => {
    const prompt = "x".repeat(1_000);
    const args = { query: "y".repeat(1_000), limit: 10 };

    expect(formatToolCall(toolCall("task", { prompt })).summary).toBe("task");
    expect(formatToolCall(toolCall("custom-tool", args)).summary).toBe("2 arguments");
  });

  it("uses fallback summaries for empty and whitespace-only display arguments", () => {
    expect(formatToolCall(toolCall("task", { description: "   " })).summary).toBe("task");
    expect(formatToolCall(toolCall("webfetch", { url: "" })).summary).toBe("url");
    expect(formatToolCall(toolCall("get-child-status", { childId: "\t" })).summary).toBe(
      "List Children"
    );
  });
});
