// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it } from "vitest";
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
      attribution: { repo: "acme/web", parentSessionId: null },
      ...overrides,
    }),
  };
}

function denialEvent(reason: string, channel = "#ops"): ToolCallEvent {
  return {
    ...BASE,
    status: "error",
    args: { channel, text: "deploy started" },
    output: reason,
  };
}

function expandFirst() {
  const buttons = screen.getAllByRole("button");
  fireEvent.click(buttons[0]);
}

describe("SlackNotifyEvent", () => {
  it("renders a successful post with channel input and a Slack permalink", () => {
    render(<SlackNotifyEvent event={successEvent()} />);

    expect(screen.getByText(/posted to #ops/i)).toBeInTheDocument();
    expandFirst();

    const link = screen.getByRole("link", { name: /view in slack/i });
    expect(link).toHaveAttribute("href", "https://slack.com/archives/C01ABC/p1700000000001");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });

  it("surfaces the truncation note when the message was truncated", () => {
    render(<SlackNotifyEvent event={successEvent({ truncated: true })} />);
    expandFirst();
    expect(screen.getByText(/truncated/i)).toBeInTheDocument();
  });

  it("surfaces the broadcast-strip note when broadcasts were removed", () => {
    render(<SlackNotifyEvent event={successEvent({ strippedBroadcasts: true })} />);
    expandFirst();
    expect(screen.getByText(/broadcast mentions/i)).toBeInTheDocument();
  });

  it("renders channel_not_found_or_forbidden with an invite-the-bot hint and no permalink", () => {
    render(<SlackNotifyEvent event={denialEvent("channel_not_found_or_forbidden")} />);

    expect(screen.getByText(/slack notify failed/i)).toBeInTheDocument();
    expandFirst();

    expect(screen.getByText(/channel not found or bot is not in the channel/i)).toBeInTheDocument();
    expect(screen.getByText(/invite the open-inspect bot/i)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /view in slack/i })).not.toBeInTheDocument();
  });

  it("renders feature_disabled with repo-specific copy", () => {
    render(<SlackNotifyEvent event={denialEvent("feature_disabled")} />);
    expandFirst();
    expect(screen.getByText(/notifications are disabled for this repository/i)).toBeInTheDocument();
  });

  it("renders rate_limited with retry-window copy", () => {
    render(<SlackNotifyEvent event={denialEvent("rate_limited")} />);
    expandFirst();
    expect(screen.getByText(/rate-limited/i)).toBeInTheDocument();
  });

  it("falls back gracefully when the output is unparseable", () => {
    const event: ToolCallEvent = {
      ...BASE,
      status: "completed",
      args: { channel: "#ops", text: "" },
      output: "not-json",
    };
    render(<SlackNotifyEvent event={event} />);
    expandFirst();
    expect(screen.getByText(/no details available/i)).toBeInTheDocument();
  });
});
