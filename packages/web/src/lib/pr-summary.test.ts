import { describe, expect, it } from "vitest";
import { dominantPullRequestState, formatPullRequestSummaryLabel } from "./pr-summary";

describe("dominantPullRequestState", () => {
  it("returns null without a summary or with zero PRs", () => {
    expect(dominantPullRequestState(undefined)).toBeNull();
    expect(
      dominantPullRequestState({ total: 0, open: 0, draft: 0, merged: 0, closed: 0 })
    ).toBeNull();
  });

  it("picks the most actionable bucket: open, draft, merged, closed", () => {
    expect(dominantPullRequestState({ total: 3, open: 1, draft: 1, merged: 1, closed: 0 })).toBe(
      "open"
    );
    expect(dominantPullRequestState({ total: 2, open: 0, draft: 1, merged: 1, closed: 0 })).toBe(
      "draft"
    );
    expect(dominantPullRequestState({ total: 2, open: 0, draft: 0, merged: 1, closed: 1 })).toBe(
      "merged"
    );
    expect(dominantPullRequestState({ total: 1, open: 0, draft: 0, merged: 0, closed: 1 })).toBe(
      "closed"
    );
  });
});

describe("formatPullRequestSummaryLabel", () => {
  it("returns null without a summary or with zero PRs", () => {
    expect(formatPullRequestSummaryLabel(undefined)).toBeNull();
    expect(
      formatPullRequestSummaryLabel({ total: 0, open: 0, draft: 0, merged: 0, closed: 0 })
    ).toBeNull();
  });

  it("renders the single PR's display status", () => {
    expect(
      formatPullRequestSummaryLabel({ total: 1, open: 0, draft: 1, merged: 0, closed: 0 })
    ).toBe("PR draft");
    expect(
      formatPullRequestSummaryLabel({ total: 1, open: 1, draft: 0, merged: 0, closed: 0 })
    ).toBe("PR open");
    expect(
      formatPullRequestSummaryLabel({ total: 1, open: 0, draft: 0, merged: 1, closed: 0 })
    ).toBe("PR merged");
    expect(
      formatPullRequestSummaryLabel({ total: 1, open: 0, draft: 0, merged: 0, closed: 1 })
    ).toBe("PR closed");
  });

  it("counts drafts as open in the multi-PR label", () => {
    expect(
      formatPullRequestSummaryLabel({ total: 3, open: 1, draft: 1, merged: 1, closed: 0 })
    ).toBe("3 PRs · 2 open");
  });

  it("falls back to merged, then closed, when nothing is open", () => {
    expect(
      formatPullRequestSummaryLabel({ total: 2, open: 0, draft: 0, merged: 2, closed: 0 })
    ).toBe("2 PRs · 2 merged");
    expect(
      formatPullRequestSummaryLabel({ total: 2, open: 0, draft: 0, merged: 0, closed: 2 })
    ).toBe("2 PRs · 2 closed");
  });
});
