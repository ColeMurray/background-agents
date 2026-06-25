// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { TriggerCondition } from "@open-inspect/shared";
import { ConditionBuilder } from "./condition-builder";

type ChannelListing = { id: string; name: string; isPrivate: boolean; isMember: boolean };
// Mutable per-test channel listing; the hoisted use-slack-channels mock closes over it.
let slackChannelsMock: { channels: ChannelListing[]; loading: boolean; error?: string };
vi.mock("@/hooks/use-slack-channels", () => ({
  useSlackChannels: () => slackChannelsMock,
}));

expect.extend(matchers);
afterEach(cleanup);
beforeEach(() => {
  slackChannelsMock = { channels: [], loading: false };
  // jsdom doesn't implement scrollIntoView, which the Combobox calls when opened.
  Element.prototype.scrollIntoView = vi.fn();
});

function renderBuilder(conditions: TriggerCondition[]) {
  const onChange = vi.fn();
  render(<ConditionBuilder conditions={conditions} onChange={onChange} triggerSource="slack" />);
  return onChange;
}

describe("ConditionBuilder — slack editors", () => {
  it("edits a text_match pattern and toggles case-insensitivity", () => {
    const onChange = renderBuilder([
      { type: "text_match", operator: "contains", value: { pattern: "" } },
    ]);

    fireEvent.change(screen.getByPlaceholderText(/Substring to look for/), {
      target: { value: "deploy" },
    });
    expect(onChange).toHaveBeenLastCalledWith([
      { type: "text_match", operator: "contains", value: { pattern: "deploy" } },
    ]);

    fireEvent.click(screen.getByLabelText("Case-insensitive"));
    expect(onChange).toHaveBeenLastCalledWith([
      { type: "text_match", operator: "contains", value: { pattern: "", flags: "i" } },
    ]);
  });

  it("falls back to manual channel-ID entry when channels can't be listed", () => {
    slackChannelsMock = { channels: [], loading: false, error: "not_configured" };
    const onChange = renderBuilder([{ type: "slack_channel", operator: "any_of", value: [] }]);

    const input = screen.getByPlaceholderText(/Add channel ID/);
    fireEvent.change(input, { target: { value: "C0123ABCD" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onChange).toHaveBeenLastCalledWith([
      { type: "slack_channel", operator: "any_of", value: ["C0123ABCD"] },
    ]);
  });

  it("picks a channel by name and stores its ID", () => {
    slackChannelsMock = {
      channels: [
        { id: "C0123ABCD", name: "general", isPrivate: false, isMember: true },
        { id: "C9999", name: "random", isPrivate: false, isMember: true },
      ],
      loading: false,
    };
    const onChange = renderBuilder([{ type: "slack_channel", operator: "any_of", value: [] }]);

    fireEvent.click(screen.getByText("Add channel..."));
    fireEvent.click(screen.getByText("#general"));

    expect(onChange).toHaveBeenLastCalledWith([
      { type: "slack_channel", operator: "any_of", value: ["C0123ABCD"] },
    ]);
  });

  it("resolves selected channel IDs to #name chips", () => {
    slackChannelsMock = {
      channels: [{ id: "C0123ABCD", name: "general", isPrivate: false, isMember: true }],
      loading: false,
    };
    renderBuilder([{ type: "slack_channel", operator: "any_of", value: ["C0123ABCD"] }]);

    expect(screen.getByText("#general")).toBeInTheDocument();
  });

  it("renders the slack_actor include/exclude control and user input", () => {
    renderBuilder([{ type: "slack_actor", operator: "include", value: [] }]);
    expect(screen.getByText("Slack User")).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Add Slack user ID/)).toBeInTheDocument();
  });
});
