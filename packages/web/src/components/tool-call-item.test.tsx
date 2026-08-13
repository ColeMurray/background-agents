// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { SandboxEvent } from "@/types/session";
import { ToolCallItem } from "./tool-call-item";

afterEach(cleanup);

describe("ToolCallItem", () => {
  it("keeps complete long commands in collapsed rows", () => {
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
    expect(button.querySelector(".truncate")).toBeNull();
  });
});
