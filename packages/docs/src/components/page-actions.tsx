import { formatReviewDate } from "@/lib/dates";
import { feedbackIssueUrl } from "@/lib/site";

type PageActionsProps = {
  editUrl: string;
  lastReviewed: string;
  markdownUrl: string;
  title: string;
};

export function PageActions({ editUrl, lastReviewed, markdownUrl, title }: PageActionsProps) {
  return (
    <div className="mb-8 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-fd-border pb-5 text-sm text-fd-muted-foreground">
      <span>
        Last reviewed <time dateTime={lastReviewed}>{formatReviewDate(lastReviewed)}</time>
      </span>
      <a className="hover:text-fd-foreground" href={markdownUrl}>
        View as Markdown
      </a>
      <a className="hover:text-fd-foreground" href={editUrl} rel="noreferrer" target="_blank">
        Edit on GitHub
      </a>
      <a
        className="hover:text-fd-foreground"
        href={feedbackIssueUrl(title)}
        rel="noreferrer"
        target="_blank"
      >
        Give feedback
      </a>
    </div>
  );
}
