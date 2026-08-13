// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { SandboxEvent } from "@/types/session";
import { ToolCallItem } from "./tool-call-item";

afterEach(cleanup);

describe("ToolCallItem", () => {
  it("ellipsizes long collapsed summaries while retaining complete text", () => {
    const command = `PYTHONPATH=src uv run pytest ${"tests/very_long_directory/".repeat(4)}test_file.py`;
    const event: Extract<SandboxEvent, { type: "tool_call" }> = {
      type: "tool_call",
      sandboxId: "sandbox-1",
      messageId: "message-call-1",
      callId: "call-1",
      tool: "Bash",
      args: { command },
      timestamp: 1,
    };

    render(<ToolCallItem event={event} isExpanded={false} onToggle={() => {}} />);

    const button = screen.getByRole("button", { name: new RegExp(command) });
    expect(button).toHaveTextContent(command);
    expect(button.querySelector(".truncate")).toHaveTextContent(`Bash ${command}`);
    expect(
      [...button.querySelectorAll("svg")].every((icon) => icon.classList.contains("mt-[3px]"))
    ).toBe(true);
  });

  it("keeps long TodoWrite arguments in a contained horizontal scroller", () => {
    const content = `implement-${"unbroken-task-description".repeat(20)}`;
    const args = {
      todos: [{ content, status: "in_progress", priority: "high" }],
    };
    const event: Extract<SandboxEvent, { type: "tool_call" }> = {
      type: "tool_call",
      sandboxId: "sandbox-1",
      messageId: "message-call-2",
      callId: "call-2",
      tool: "TodoWrite",
      args,
      timestamp: 1,
    };

    render(<ToolCallItem event={event} isExpanded onToggle={() => {}} />);

    const argumentsPre = screen.getByText("Arguments:").nextElementSibling;
    expect(argumentsPre?.textContent).toBe(JSON.stringify(args, null, 2));
    expect(argumentsPre).toHaveClass("w-full", "max-w-full", "overflow-x-auto", "whitespace-pre");
  });

  it("keeps Apply Patch content preformatted and horizontally scrollable", () => {
    const patchText = `*** Begin Patch\n*** Update File: source.ts\n-${"old".repeat(80)}\n+${"new".repeat(80)}\n*** End Patch`;
    const event: Extract<SandboxEvent, { type: "tool_call" }> = {
      type: "tool_call",
      sandboxId: "sandbox-1",
      messageId: "message-call-3",
      callId: "call-3",
      tool: "apply_patch",
      args: { patchText },
      timestamp: 1,
    };

    render(<ToolCallItem event={event} isExpanded onToggle={() => {}} />);

    const patchPre = screen.getByText("Patch:").nextElementSibling;
    expect(patchPre?.textContent).toBe(patchText);
    expect(patchPre).toHaveClass("overflow-x-auto", "whitespace-pre");
    expect(patchPre).not.toHaveClass("whitespace-pre-wrap", "[overflow-wrap:anywhere]");
  });

  it("keeps Bash output preformatted and horizontally scrollable", () => {
    const output = `COLUMN_A    COLUMN_B    ${"wide-terminal-value".repeat(20)}`;
    const event: Extract<SandboxEvent, { type: "tool_call" }> = {
      type: "tool_call",
      sandboxId: "sandbox-1",
      messageId: "message-call-4",
      callId: "call-4",
      tool: "Bash",
      args: { command: "print-table" },
      output,
      timestamp: 1,
    };

    render(<ToolCallItem event={event} isExpanded onToggle={() => {}} />);

    const outputPre = screen.getByText("Output:").nextElementSibling;
    expect(outputPre?.textContent).toBe(output);
    expect(outputPre).toHaveClass("overflow-x-auto", "whitespace-pre");
    expect(outputPre).not.toHaveClass("whitespace-pre-wrap", "[overflow-wrap:anywhere]");
  });
});
