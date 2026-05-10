// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { SandboxEvent } from "@/types/session";
import { SlackNotifyEvent } from "./slack-notify-event";

expect.extend(matchers);
afterEach(() => {
  cleanup();
});

type ToolCallEvent = Extract<SandboxEvent, { type: "tool_call" }>;

const BASE: Omit<ToolCallEvent, "args" | "output" | "status"> = {
  type: "tool_call",
  tool: "slack-notify",
  callId: "call-1",
  messageId: "msg-1",
  sandboxId: "control-plane",
  timestamp: 1_700_000_000,
};

function successEvent(overrides: Record<string, unknown> = {}): ToolCallEvent {
  return {
    ...BASE,
    status: "completed",
    args: { channel: "#ops", text: "deploy started" },
    output: JSON.stringify({
      ok: true,
      channelInput: "#ops",
      channelId: "C01ABC",
      messageTs: "1700000000.001",
      permalink: "https://slack.com/archives/C01ABC/p1700000000001",
      truncated: false,
      strippedBroadcasts: false,
      mentionsModified: false,
      ...overrides,
    }),
  };
}

function denialEvent(reason: string, channel = "#ops"): ToolCallEvent {
  // Denials are status="completed" — the renderer keys off ok:false + reason, not status.
  return {
    ...BASE,
    status: "completed",
    args: { channel, text: "deploy started" },
    output: JSON.stringify({
      ok: false,
      reason,
      agentMessage: `denial: ${reason}`,
    }),
  };
}

function legacyDenialEvent(reason: string): ToolCallEvent {
  // Legacy shape: status="error" with the bare reason code as `output`.
  return {
    ...BASE,
    status: "error",
    args: { channel: "#ops", text: "deploy started" },
    output: reason,
  };
}

function renderExpanded(event: ToolCallEvent) {
  return render(<SlackNotifyEvent event={event} isExpanded onToggle={() => {}} />);
}

describe("SlackNotifyEvent", () => {
  it("invokes onToggle when the row is clicked, leaving expansion to the parent", () => {
    const onToggle = vi.fn();
    render(<SlackNotifyEvent event={successEvent()} isExpanded={false} onToggle={onToggle} />);

    expect(screen.queryByRole("link", { name: /view in slack/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button"));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("renders a successful post with channel input and a Slack permalink", () => {
    renderExpanded(successEvent());

    expect(screen.getByText(/posted to #ops/i)).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /view in slack/i });
    expect(link).toHaveAttribute("href", "https://slack.com/archives/C01ABC/p1700000000001");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
    expect(link).toHaveAttribute("rel", expect.stringContaining("noreferrer"));
  });

  it("does not render a link when the permalink uses an unsafe scheme", () => {
    renderExpanded(successEvent({ permalink: "javascript:alert(1)" }));

    expect(screen.getByText(/posted to #ops/i)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /view in slack/i })).not.toBeInTheDocument();
  });

  it("surfaces the truncation note when the message was truncated", () => {
    renderExpanded(successEvent({ truncated: true }));
    expect(screen.getByText(/truncated/i)).toBeInTheDocument();
  });

  it("surfaces the broadcast-strip note when broadcasts were removed", () => {
    renderExpanded(successEvent({ strippedBroadcasts: true }));
    expect(screen.getByText(/broadcast mentions/i)).toBeInTheDocument();
  });

  it("renders channel_not_found_or_forbidden with an invite-the-bot hint and no permalink", () => {
    renderExpanded(denialEvent("channel_not_found_or_forbidden"));

    expect(screen.getByText(/slack notify failed/i)).toBeInTheDocument();
    expect(screen.getByText(/channel not found or bot is not in the channel/i)).toBeInTheDocument();
    expect(screen.getByText(/invite the open-inspect bot/i)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /view in slack/i })).not.toBeInTheDocument();
  });

  it("renders feature_disabled with repo-specific copy", () => {
    renderExpanded(denialEvent("feature_disabled"));
    expect(screen.getByText(/notifications are disabled for this repository/i)).toBeInTheDocument();
  });

  it("renders rate_limited with retry-window copy", () => {
    renderExpanded(denialEvent("rate_limited"));
    expect(screen.getByText(/rate-limited/i)).toBeInTheDocument();
  });

  it("surfaces the concrete retryAfter for rate_limited when provided", () => {
    const event: ToolCallEvent = {
      ...BASE,
      status: "completed",
      args: { channel: "#ops", text: "hi" },
      output: JSON.stringify({
        ok: false,
        reason: "rate_limited",
        agentMessage: "Slack rate-limited the request.",
        retryAfter: 30,
      }),
    };
    renderExpanded(event);
    expect(screen.getByText(/wait/i)).toBeInTheDocument();
    expect(screen.getByText("30s")).toBeInTheDocument();
  });

  it("renders bridge_error when the plugin couldn't reach the control plane", () => {
    renderExpanded(denialEvent("bridge_error"));
    expect(screen.getByText(/couldn't reach the control plane/i)).toBeInTheDocument();
  });

  it("renders legacy denial events (status=error, bare reason) for backward compat", () => {
    renderExpanded(legacyDenialEvent("channel_not_found_or_forbidden"));
    expect(screen.getByText(/channel not found or bot is not in the channel/i)).toBeInTheDocument();
  });

  it("falls back gracefully when the output is unparseable", () => {
    const event: ToolCallEvent = {
      ...BASE,
      status: "completed",
      args: { channel: "#ops", text: "" },
      output: "not-json",
    };
    renderExpanded(event);
    expect(screen.getByText(/no details available/i)).toBeInTheDocument();
  });
});
