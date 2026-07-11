import type { PullRequestDisplayStatus, PullRequestSummary } from "@open-inspect/shared";

/**
 * The single display state a session-list row's PR icon shows. With several
 * PRs the most actionable bucket wins: open, then draft, then merged, then
 * closed. Null when the session has no tracked PRs.
 */
export function dominantPullRequestState(
  summary: PullRequestSummary | undefined
): PullRequestDisplayStatus | null {
  if (!summary || summary.total === 0) return null;
  if (summary.open > 0) return "open";
  if (summary.draft > 0) return "draft";
  if (summary.merged > 0) return "merged";
  return "closed";
}

/**
 * Fixed-height PR indicator for a session list row (design §7): a single PR
 * renders its display status ("PR merged"); several render the count plus the
 * most informative bucket — open (incl. drafts) wins, then merged, then
 * closed. Null when the session has no tracked PRs.
 */
export function formatPullRequestSummaryLabel(
  summary: PullRequestSummary | undefined
): string | null {
  if (!summary || summary.total === 0) return null;

  if (summary.total === 1) {
    if (summary.draft > 0) return "PR draft";
    if (summary.open > 0) return "PR open";
    if (summary.merged > 0) return "PR merged";
    return "PR closed";
  }

  const openCount = summary.open + summary.draft;
  if (openCount > 0) return `${summary.total} PRs · ${openCount} open`;
  if (summary.merged > 0) return `${summary.total} PRs · ${summary.merged} merged`;
  return `${summary.total} PRs · ${summary.closed} closed`;
}
