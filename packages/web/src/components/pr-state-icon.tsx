import type { PullRequestDisplayStatus } from "@open-inspect/shared";
import { GitMergeIcon, GitPrClosedIcon, GitPrDraftIcon, GitPrIcon } from "@/components/ui/icons";

const PR_STATE_ICON_TEXT_CLASS: Record<PullRequestDisplayStatus, string> = {
  open: "text-[#1f883d] dark:text-[#3fb950]",
  draft: "text-[#656d76] dark:text-[#8c959f]",
  merged: "text-[#8250df] dark:text-[#a371f7]",
  closed: "text-[#cf222e] dark:text-[#f85149]",
};

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
 * GitHub-style PR state icon for a session-list row.
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
      className={`flex-shrink-0 ${PR_STATE_ICON_TEXT_CLASS[state]}`}
      title={label}
      aria-label={label}
      data-testid={`pr-state-${state}`}
    >
      <Icon className="w-3.5 h-3.5" />
    </span>
  );
}
