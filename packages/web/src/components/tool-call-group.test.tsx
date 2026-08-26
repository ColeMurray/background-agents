// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { SandboxEvent } from "@/types/session";
import { ToolCallGroup } from "./tool-call-group";

afterEach(cleanup);

describe("ToolCallGroup", () => {
  it("aligns grouped action icons with the text", () => {
    const events: Array<Extract<SandboxEvent, { type: "tool_call" }>> = [
      {
        type: "tool_call",
        sandboxId: "sandbox-1",
        messageId: "message-1",
        callId: "call-1",
        tool: "Bash",
        args: { command: "pwd" },
        timestamp: 1,
      },
      {
        type: "tool_call",
        sandboxId: "sandbox-1",
        messageId: "message-2",
        callId: "call-2",
        tool: "Bash",
        args: { command: "ls" },
        timestamp: 2,
      },
    ];

    render(
      <ToolCallGroup
        events={events}
        isExpanded={false}
        expandedToolCallIds={new Set()}
        onToggleGroup={() => {}}
        onToggleTool={() => {}}
      />
    );

    const button = screen.getByRole("button", { name: /Bash 2 commands/ });
    const icons = button.querySelectorAll("svg");

    expect(icons).toHaveLength(2);
    expect([...icons].every((icon) => icon.classList.contains("mt-[3px]"))).toBe(true);
  });
});
