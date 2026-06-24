// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { TriggerCondition } from "@open-inspect/shared";
import { ConditionBuilder } from "./condition-builder";

expect.extend(matchers);
afterEach(cleanup);

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

  it("renders a slack_channel tag input and adds a channel ID", () => {
    const onChange = renderBuilder([{ type: "slack_channel", operator: "any_of", value: [] }]);

    const input = screen.getByPlaceholderText(/Add channel ID/);
    fireEvent.change(input, { target: { value: "C0123ABCD" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onChange).toHaveBeenLastCalledWith([
      { type: "slack_channel", operator: "any_of", value: ["C0123ABCD"] },
    ]);
  });

  it("renders the slack_actor include/exclude control and user input", () => {
    renderBuilder([{ type: "slack_actor", operator: "include", value: [] }]);
    expect(screen.getByText("Slack User")).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Add Slack user ID/)).toBeInTheDocument();
  });
});
