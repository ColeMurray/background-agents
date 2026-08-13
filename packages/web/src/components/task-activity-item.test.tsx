// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolCallEvent } from "@/lib/timeline-items";
import { TaskActivityItem } from "./task-activity-item";

afterEach(cleanup);

describe("TaskActivityItem", () => {
  it("aligns the task icons and running indicator with the text", () => {
    const event: ToolCallEvent = {
      type: "tool_call",
      sandboxId: "sandbox-1",
      messageId: "message-1",
      callId: "call-1",
      tool: "Task",
      args: {
        description: "Explore timeline rendering",
        subagent_type: "explore",
      },
      status: "running",
      timestamp: 1,
    };

    render(
      <TaskActivityItem event={event} hasActivity={false}>
        {null}
      </TaskActivityItem>
    );

    const button = screen.getByRole("button", { name: /Task Explore timeline rendering/ });
    const icons = button.querySelectorAll("svg");
    const indicator = button.querySelector('[aria-hidden="true"]');

    expect(icons).toHaveLength(2);
    expect([...icons].every((icon) => icon.classList.contains("mt-[3px]"))).toBe(true);
    expect(indicator).toHaveClass("mt-1.5");
  });

  it("contains expanded activity within a nested scroll area", () => {
    const event: ToolCallEvent = {
      type: "tool_call",
      sandboxId: "sandbox-1",
      messageId: "message-1",
      callId: "call-1",
      tool: "Task",
      args: { description: "Explore timeline rendering" },
      status: "completed",
      timestamp: 1,
    };

    render(
      <TaskActivityItem event={event} hasActivity>
        <div>Nested activity</div>
      </TaskActivityItem>
    );

    fireEvent.click(screen.getByRole("button", { name: /Task Explore timeline rendering/ }));

    expect(screen.getByText("Task activity").parentElement).toHaveClass(
      "max-h-96",
      "overflow-y-auto",
      "overflow-x-hidden",
      "overscroll-contain"
    );
    expect(screen.getByText("Nested activity")).toBeVisible();
  });
});
