// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import {
  CHECK_SUITE_CONCLUSIONS,
  WORKFLOW_RUN_CONCLUSIONS,
  type AutomationEventSource,
  type TriggerCondition,
} from "@open-inspect/shared/triggers";
import { ConditionBuilder } from "./condition-builder";

type ChannelListing = { id: string; name: string; isPrivate: boolean; isMember: boolean };
const DEFAULT_TRIGGER_SOURCE: AutomationEventSource = "slack";
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

function renderBuilder(
  conditions: TriggerCondition[],
  triggerSource: AutomationEventSource = DEFAULT_TRIGGER_SOURCE,
  eventType?: string
) {
  const onChange = vi.fn();
  render(
    <ConditionBuilder
      conditions={conditions}
      onChange={onChange}
      triggerSource={triggerSource}
      eventType={eventType}
    />
  );
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

describe("ConditionBuilder — GitHub workflow editors", () => {
  it("stores the exact workflow name", () => {
    const onChange = renderBuilder(
      [{ type: "workflow_name", operator: "eq", value: "" }],
      "github",
      "workflow_run.completed"
    );

    fireEvent.change(screen.getByPlaceholderText(/Exact workflow name/), {
      target: { value: "CI" },
    });

    expect(onChange).toHaveBeenLastCalledWith([
      { type: "workflow_name", operator: "eq", value: "CI" },
    ]);
  });

  it.each(WORKFLOW_RUN_CONCLUSIONS)("renders the %s workflow conclusion", (conclusion) => {
    renderBuilder(
      [{ type: "conclusion", operator: "eq", value: conclusion }],
      "github",
      "workflow_run.completed"
    );

    expect(screen.getByText("Conclusion")).toBeInTheDocument();
    expect(screen.getAllByRole("combobox")[0]).toHaveTextContent(conclusion);
  });

  it.each(CHECK_SUITE_CONCLUSIONS)("renders the %s check suite conclusion", (conclusion) => {
    renderBuilder(
      [{ type: "check_conclusion", operator: "eq", value: conclusion }],
      "github",
      "check_suite.completed"
    );

    expect(screen.getAllByRole("combobox")[0]).toHaveTextContent(conclusion);
  });

  it("does not offer check-suite-only conclusions for workflow runs", () => {
    renderBuilder(
      [{ type: "conclusion", operator: "eq", value: "success" }],
      "github",
      "workflow_run.completed"
    );

    fireEvent.click(screen.getAllByRole("combobox")[0]);
    expect(screen.queryByText("startup_failure")).not.toBeInTheDocument();
  });

  it("offers workflow filters only for workflow run events", () => {
    renderBuilder([], "github", "workflow_run.completed");

    fireEvent.click(screen.getByText("Add condition..."));

    expect(screen.getByText("Workflow Name")).toBeInTheDocument();
    expect(screen.getByText("Conclusion")).toBeInTheDocument();
    expect(screen.queryByText("Check Conclusion")).not.toBeInTheDocument();
  });

  it("does not offer workflow filters for pull request events", () => {
    renderBuilder([], "github", "pull_request.opened");

    fireEvent.click(screen.getByText("Add condition..."));

    expect(screen.queryByText("Workflow Name")).not.toBeInTheDocument();
    expect(screen.queryByText("Conclusion")).not.toBeInTheDocument();
    expect(screen.queryByText("Check Conclusion")).not.toBeInTheDocument();
    expect(screen.queryByText("Path Glob")).not.toBeInTheDocument();
    expect(screen.getByText("Target branch")).toBeInTheDocument();
  });

  it("leaves a persisted condition the event type cannot answer for the user to remove", () => {
    const onChange = renderBuilder(
      [{ type: "path_glob", operator: "any_match", value: ["src/**"] }],
      "github",
      "pull_request.opened"
    );

    expect(screen.getByText("Path Glob")).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps a persisted legacy check conclusion condition editable", () => {
    const onChange = renderBuilder(
      [{ type: "check_conclusion", operator: "eq", value: "failure" }],
      "github",
      "check_suite.completed"
    );

    expect(screen.getByText("Check Conclusion")).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not offer the conclusion alias when a legacy conclusion exists", () => {
    renderBuilder(
      [{ type: "check_conclusion", operator: "eq", value: "failure" }],
      "github",
      "check_suite.completed"
    );

    fireEvent.click(screen.getByText("Add condition..."));

    expect(screen.queryByRole("option", { name: "Conclusion" })).not.toBeInTheDocument();
  });
});
