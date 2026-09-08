import { describe, expect, it } from "vitest";
import { pullRequestSummaryDisplay } from "./pr-summary";

describe("pullRequestSummaryDisplay", () => {
  it("returns null without a summary or with zero PRs", () => {
    expect(pullRequestSummaryDisplay(undefined)).toBeNull();
    expect(
      pullRequestSummaryDisplay({ total: 0, open: 0, draft: 0, merged: 0, closed: 0 })
    ).toBeNull();
  });

  it("renders a single PR's display status as both state and label", () => {
    expect(
      pullRequestSummaryDisplay({ total: 1, open: 0, draft: 1, merged: 0, closed: 0 })
    ).toEqual({ state: "draft", label: "PR draft" });
    expect(
      pullRequestSummaryDisplay({ total: 1, open: 1, draft: 0, merged: 0, closed: 0 })
    ).toEqual({ state: "open", label: "PR open" });
    expect(
      pullRequestSummaryDisplay({ total: 1, open: 0, draft: 0, merged: 1, closed: 0 })
    ).toEqual({ state: "merged", label: "PR merged" });
    expect(
      pullRequestSummaryDisplay({ total: 1, open: 0, draft: 0, merged: 0, closed: 1 })
    ).toEqual({ state: "closed", label: "PR closed" });
  });

  it("picks the most actionable state and counts drafts as open in the label", () => {
    expect(
      pullRequestSummaryDisplay({ total: 3, open: 1, draft: 1, merged: 1, closed: 0 })
    ).toEqual({ state: "open", label: "3 PRs · 2 open" });
    expect(
      pullRequestSummaryDisplay({ total: 2, open: 0, draft: 1, merged: 1, closed: 0 })
    ).toEqual({ state: "draft", label: "2 PRs · 1 open" });
  });

  it("falls back to merged, then closed, when nothing is open", () => {
    expect(
      pullRequestSummaryDisplay({ total: 2, open: 0, draft: 0, merged: 2, closed: 0 })
    ).toEqual({ state: "merged", label: "2 PRs · 2 merged" });
    expect(
      pullRequestSummaryDisplay({ total: 2, open: 0, draft: 0, merged: 1, closed: 1 })
    ).toEqual({ state: "merged", label: "2 PRs · 1 merged" });
    expect(
      pullRequestSummaryDisplay({ total: 2, open: 0, draft: 0, merged: 0, closed: 2 })
    ).toEqual({ state: "closed", label: "2 PRs · 2 closed" });
  });
});
