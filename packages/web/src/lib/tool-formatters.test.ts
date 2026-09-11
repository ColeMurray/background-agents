import { describe, expect, it } from "vitest";
import type { SandboxEvent } from "@/types/session";
import {
  formatToolCall,
  formatToolGroup,
  isSubtaskRootTool,
  parseMcpToolName,
} from "./tool-formatters";

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

describe("formatToolCall Claude Agent tool names", () => {
  it("matches capitalized tool names and snake_case argument keys", () => {
    expect(formatToolCall(toolCall("Read", { file_path: "/repo/src/index.ts" }))).toMatchObject({
      toolName: "Read",
      summary: "index.ts",
    });
    expect(formatToolCall(toolCall("Write", { file_path: "/repo/README.md" }))).toMatchObject({
      toolName: "Write",
      summary: "README.md",
    });
    expect(formatToolCall(toolCall("Bash", { command: "npm test" }))).toMatchObject({
      toolName: "Bash",
      summary: "npm test",
    });
    expect(formatToolCall(toolCall("Grep", { pattern: "TODO", path: "src" }))).toMatchObject({
      toolName: "Grep",
      summary: '"TODO"',
    });
    expect(formatToolCall(toolCall("Glob", { pattern: "**/*.ts" }))).toMatchObject({
      toolName: "Glob",
      summary: "**/*.ts",
    });
    expect(formatToolCall(toolCall("WebFetch", { url: "https://example.com" }))).toMatchObject({
      toolName: "WebFetch",
      summary: "https://example.com",
    });
    expect(formatToolCall(toolCall("WebSearch", { query: "vitest" }))).toMatchObject({
      toolName: "WebSearch",
      summary: '"vitest"',
    });
    expect(formatToolCall(toolCall("TodoWrite", { todos: [{}, {}] }))).toMatchObject({
      toolName: "TodoWrite",
      summary: "2 items",
    });
    expect(formatToolCall(toolCall("Skill", { skill: "visual-verification" }))).toMatchObject({
      toolName: "skill",
      summary: '"visual-verification"',
    });
  });

  it("treats only the runtime-neutral task tool as a subtask root", () => {
    // The Claude runtime maps its Agent tool to `task` at the event boundary,
    // so the vendor spelling never reaches the timeline.
    expect(isSubtaskRootTool("task")).toBe(true);
    expect(isSubtaskRootTool("Task")).toBe(true);
    expect(isSubtaskRootTool("Agent")).toBe(false);
    expect(isSubtaskRootTool("TaskCreate")).toBe(false);
    expect(isSubtaskRootTool(undefined)).toBe(false);
  });

  it("formats MultiEdit with its edit count", () => {
    expect(
      formatToolCall(toolCall("MultiEdit", { file_path: "/repo/src/app.ts", edits: [{}, {}, {}] }))
    ).toMatchObject({ toolName: "Edit", summary: "app.ts (3 edits)", icon: "pencil" });
  });

  it("formats NotebookEdit with the notebook name", () => {
    expect(
      formatToolCall(toolCall("NotebookEdit", { notebook_path: "/repo/analysis.ipynb" }))
    ).toMatchObject({ toolName: "NotebookEdit", summary: "analysis.ipynb" });
  });

  it("summarizes TaskCreate and TaskUpdate from subject, description, and status", () => {
    expect(formatToolCall(toolCall("TaskCreate", { subject: "Fix flaky test" }))).toMatchObject({
      toolName: "TaskCreate",
      summary: "Fix flaky test",
    });
    expect(
      formatToolCall(toolCall("TaskCreate", { description: "Investigate the timeout" }))
    ).toMatchObject({ summary: "Investigate the timeout" });
    expect(
      formatToolCall(toolCall("TaskUpdate", { taskId: "3", status: "completed" }))
    ).toMatchObject({ toolName: "TaskUpdate", summary: "3 (completed)" });
    expect(formatToolCall(toolCall("TaskUpdate", { status: "in_progress" })).summary).toBe(
      "in_progress"
    );
  });

  it("formats AskUserQuestion with the question count", () => {
    expect(
      formatToolCall(toolCall("AskUserQuestion", { questions: [{ question: "Which?" }] }))
    ).toMatchObject({ toolName: "AskUserQuestion", summary: "1 question" });
  });

  it("formats MCP tools as server: tool", () => {
    expect(parseMcpToolName("mcp__linear__create_issue")).toEqual({
      server: "linear",
      tool: "create_issue",
    });
    expect(parseMcpToolName("mcp__linear")).toBeNull();
    expect(parseMcpToolName("read")).toBeNull();
    expect(
      formatToolCall(toolCall("mcp__linear__create_issue", { title: "Bug", team: "COL" }))
    ).toMatchObject({ toolName: "linear: create_issue", summary: "2 arguments", icon: null });
  });
});

describe("formatToolGroup", () => {
  it("groups capitalized Claude Agent tool names with their OpenCode equivalents", () => {
    expect(
      formatToolGroup([toolCall("Read", { file_path: "a" }), toolCall("Read", { file_path: "b" })])
    ).toEqual({ toolName: "Read", count: 2, summary: "2 files" });
    expect(formatToolGroup([toolCall("MultiEdit", { file_path: "a", edits: [] })])).toEqual({
      toolName: "Edit",
      count: 1,
      summary: "1 file",
    });
    expect(formatToolGroup([toolCall("Bash", { command: "ls" })])).toEqual({
      toolName: "Bash",
      count: 1,
      summary: "1 command",
    });
  });

  it("labels MCP tool groups by server and tool", () => {
    expect(
      formatToolGroup([toolCall("mcp__github__search", {}), toolCall("mcp__github__search", {})])
    ).toEqual({ toolName: "github: search", count: 2, summary: "2 calls" });
  });
});
