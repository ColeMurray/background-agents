// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SandboxEvent } from "@/types/session";
import { childStatusDetailOutput } from "../../../sandbox-runtime/src/sandbox_runtime/tools/get-child-status-format.js";
import { ToolCallItem } from "./tool-call-item";
import { ToolCallGroup } from "./tool-call-group";
import { toolCallKey } from "@/lib/timeline-items";

afterEach(cleanup);

const detail = {
  version: 1,
  kind: "detail",
  session: {
    id: "child-1",
    title: "Validate the timeline",
    status: "completed",
    repoOwner: "acme/team",
    repoName: "web",
    branchName: "fix/timeline",
    model: "test-model",
    createdAt: 1700000000000,
    updatedAt: 1700000060000,
  },
  finalResponse: {
    success: true,
    textContent: "## Result\n\n**Tests passed**\n\n[PR #42](https://github.com/acme/web/pull/42)",
  },
  hasUnfinishedPrompt: false,
  agentMessage: "Child: child-1\n  Trajectory: more events available",
};

function event(output: unknown = detail): Extract<SandboxEvent, { type: "tool_call" }> {
  return {
    type: "tool_call",
    tool: "get-child-status",
    sandboxId: "sandbox-1",
    messageId: "message-1",
    callId: "call-1",
    timestamp: 1,
    status: "completed",
    args: { childId: "child-1", includeResponse: true },
    output: typeof output === "string" ? output : JSON.stringify(output),
  };
}

function show(call = event()) {
  return render(<ToolCallItem event={call} isExpanded onToggle={() => {}} />);
}

describe("child status tool presentation", () => {
  it("renders linked metadata and a Markdown final response through ToolCallItem", () => {
    show();
    expect(screen.getByRole("link", { name: "Validate the timeline" })).toHaveAttribute(
      "href",
      "/session/child-1"
    );
    expect(screen.getByText("completed")).toBeInTheDocument();
    expect(screen.getByText("acme/team/web")).toBeInTheDocument();
    expect(screen.getByText("fix/timeline")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Final response" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Result" })).toBeInTheDocument();
    expect(screen.getByText("Tests passed").tagName).toBe("STRONG");
    expect(screen.getByRole("link", { name: "PR #42" })).toHaveAttribute(
      "href",
      "https://github.com/acme/web/pull/42"
    );
    expect(screen.getByText("Full tool output")).toBeInTheDocument();
  });

  it("includes the producer's original Markdown inside Full tool output", () => {
    const output = childStatusDetailOutput(
      { session: detail.session, finalResponse: detail.finalResponse },
      detail.session.id,
      { includeResponse: true }
    );
    expect(JSON.parse(output).agentMessage).not.toContain(detail.finalResponse.textContent);
    show(event(output));
    const summary = screen.getByText("Full tool output");
    fireEvent.click(summary);
    const disclosure = summary.closest("details");
    expect(disclosure).toHaveAttribute("open");
    expect(disclosure?.querySelector("pre")?.textContent).toContain(
      detail.finalResponse.textContent
    );
    expect(disclosure?.querySelector("pre")?.textContent).toContain("finalResponse.textContent:");
  });

  it("labels a previous response while another prompt is unfinished", () => {
    show(event({ ...detail, hasUnfinishedPrompt: true }));
    expect(screen.getByRole("heading", { name: "Latest completed response" })).toBeInTheDocument();
    expect(screen.getByText("A newer prompt is queued or running.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Final response" })).not.toBeInTheDocument();
  });

  it("shows response failures and event-limit information", () => {
    show(
      event({
        ...detail,
        finalResponse: {
          success: false,
          textContent: "",
          error: "Tests failed",
          eventLimitReached: true,
          eventCount: 1000,
        },
      })
    );
    expect(screen.getByText("Tests failed")).toBeInTheDocument();
    expect(screen.getByText("Response failed")).toBeInTheDocument();
    expect(screen.getByText(/1000 events.*limit reached/)).toBeInTheDocument();
  });

  it("shows that the requested final response is not available yet", () => {
    show(event({ ...detail, finalResponse: null }));
    expect(screen.getByText("Final response is not available yet.")).toBeInTheDocument();
  });

  it("renders list and empty results", () => {
    const view = show(
      event({
        version: 1,
        kind: "list",
        children: [detail.session],
        agentMessage: "1 child session",
      })
    );
    expect(screen.getByRole("heading", { name: "Child sessions (1)" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Validate the timeline" })).toBeInTheDocument();
    view.rerender(
      <ToolCallItem
        event={event({
          version: 1,
          kind: "list",
          children: [],
          agentMessage: "No child sessions found.",
        })}
        isExpanded
        onToggle={() => {}}
      />
    );
    expect(screen.getByText("No child sessions found.", { selector: "p" })).toBeInTheDocument();
  });

  it("works in grouped calls, preserves toggling, and supports the legacy tool name", () => {
    const first = { ...event(), tool: "get-task-status" };
    const second = { ...event(), callId: "call-2" };
    const onToggleTool = vi.fn();
    render(
      <ToolCallGroup
        events={[first, second]}
        isExpanded
        expandedToolCallIds={new Set([toolCallKey(first)])}
        onToggleGroup={() => {}}
        onToggleTool={onToggleTool}
      />
    );
    expect(screen.getAllByRole("link", { name: "Validate the timeline" })).toHaveLength(1);
    fireEvent.click(screen.getAllByRole("button", { name: /Child Status child-1/ })[0]);
    expect(onToggleTool).toHaveBeenCalledWith(first);
  });

  it.each([
    "Child: child-1\n  Final response: old readable output",
    "{broken JSON",
    { ...detail, version: 99 },
    { ...detail, session: { id: 123 } },
  ])("preserves generic output for unsupported or old payloads: %j", (output) => {
    show(event(output));
    expect(screen.getByText("Output:").nextElementSibling?.textContent).toBe(event(output).output);
  });

  it("never presents truncated output as a complete status", () => {
    show({ ...event(), truncated: { fields: ["output"], originalBytes: 2000000 } });
    expect(screen.getByText("Output was truncated.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Validate the timeline" })).not.toBeInTheDocument();
  });

  it("sanitizes child Markdown and contains long responses", () => {
    const view = show(
      event({
        ...detail,
        finalResponse: {
          success: true,
          textContent:
            "[unsafe](javascript:alert(1))\n\n<script>alert(1)</script>\n\n" +
            "Long response ".repeat(300),
        },
      })
    );
    expect(view.container.querySelector("script")).toBeNull();
    expect(view.container.querySelector('a[href^="javascript:"]')).toBeNull();
    const response = screen.getByRole("region", { name: "Final response" });
    expect(response).toHaveClass("max-h-96", "overflow-auto");
    expect(within(response).getByText(/Long response/)).toBeInTheDocument();
  });
});
