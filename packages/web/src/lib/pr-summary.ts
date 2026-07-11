import type { PullRequestDisplayStatus, PullRequestSummary } from "@open-inspect/shared";

/**
 * Everything a session-list row shows for its PRs, computed in one pass so
 * the state icon and the text label can never disagree.
 */
export interface PullRequestSummaryDisplay {
  /**
   * The most actionable bucket: open, then draft, then merged, then closed.
   * Drives the row's state icon.
   */
  state: PullRequestDisplayStatus;
  /**
   * Fixed-height indicator text (design §7): a single PR renders its display
   * status ("PR merged"); several render the count plus the most informative
   * bucket — open (incl. drafts) wins, then merged, then closed.
   */
  label: string;
}

/** Null when the session has no tracked PRs. */
export function pullRequestSummaryDisplay(
  summary: PullRequestSummary | undefined
): PullRequestSummaryDisplay | null {
  if (!summary || summary.total === 0) return null;

  const state: PullRequestDisplayStatus =
    summary.open > 0
      ? "open"
      : summary.draft > 0
        ? "draft"
        : summary.merged > 0
          ? "merged"
          : "closed";

  if (summary.total === 1) {
    return { state, label: `PR ${state}` };
  }

  const openCount = summary.open + summary.draft;
  const label =
    openCount > 0
      ? `${summary.total} PRs · ${openCount} open`
      : summary.merged > 0
        ? `${summary.total} PRs · ${summary.merged} merged`
        : `${summary.total} PRs · ${summary.closed} closed`;
  return { state, label };
}
