import type { PullRequestDisplayStatus } from "@open-inspect/shared";
import { PR_STATE_TEXT_CLASS } from "@/components/ui/badge";
import { GitMergeIcon, GitPrClosedIcon, GitPrDraftIcon, GitPrIcon } from "@/components/ui/icons";

const PR_STATE_ICONS: Record<
  PullRequestDisplayStatus,
  (props: { className?: string }) => React.JSX.Element
> = {
  open: GitPrIcon,
  draft: GitPrDraftIcon,
  merged: GitMergeIcon,
  closed: GitPrClosedIcon,
};

/**
 * GitHub-style PR state icon for a session-list row. Colors come from
 * PR_STATE_TEXT_CLASS — the same tokens the PR badge variants use.
 */
export function PullRequestStateIcon({
  state,
  label,
}: {
  state: PullRequestDisplayStatus;
  label: string;
}) {
  const Icon = PR_STATE_ICONS[state];
  return (
    <span
      className={`flex-shrink-0 ${PR_STATE_TEXT_CLASS[state]}`}
      title={label}
      aria-label={label}
      data-testid={`pr-state-${state}`}
    >
      <Icon className="w-3.5 h-3.5" />
    </span>
  );
}
