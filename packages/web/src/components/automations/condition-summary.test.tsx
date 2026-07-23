// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { TriggerCondition } from "@open-inspect/shared";
import { ConditionSummary } from "./condition-summary";

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
});

function renderSummary(conditions: TriggerCondition[]) {
  render(<ConditionSummary conditions={conditions} />);
}

describe("ConditionSummary", () => {
  it("resolves slack_channel IDs to #names and falls back to the ID when unknown", () => {
    slackChannelsMock = {
      channels: [{ id: "C0AV0V949D0", name: "general", isPrivate: false, isMember: true }],
      loading: false,
    };
    renderSummary([
      { type: "slack_channel", operator: "any_of", value: ["C0AV0V949D0", "C_UNKNOWN"] },
    ]);

    expect(screen.getByText(/#general, C_UNKNOWN/)).toBeInTheDocument();
  });

  it("renders a text_match pattern instead of [object Object]", () => {
    renderSummary([{ type: "text_match", operator: "contains", value: { pattern: "deploy" } }]);

    expect(screen.getByText(/deploy/)).toBeInTheDocument();
    expect(screen.queryByText(/object Object/)).not.toBeInTheDocument();
  });

  it("appends regex flags to a text_match pattern", () => {
    renderSummary([
      { type: "text_match", operator: "regex", value: { pattern: "rollback", flags: "i" } },
    ]);

    expect(screen.getByText(/rollback \(i\)/)).toBeInTheDocument();
  });

  it("renders jsonpath filters readably instead of [object Object]", () => {
    renderSummary([
      {
        type: "jsonpath",
        operator: "all_match",
        value: [
          { path: "$.level", comparison: "eq", value: "error" },
          { path: "$.tags", comparison: "exists" },
        ],
      },
    ]);

    expect(screen.getByText(/\$\.level eq error/)).toBeInTheDocument();
    expect(screen.getByText(/\$\.tags exists/)).toBeInTheDocument();
    expect(screen.queryByText(/object Object/)).not.toBeInTheDocument();
  });

  it("joins plain string-array values", () => {
    renderSummary([{ type: "label", operator: "any_of", value: ["bug", "urgent"] }]);

    expect(screen.getByText(/bug, urgent/)).toBeInTheDocument();
  });
});
