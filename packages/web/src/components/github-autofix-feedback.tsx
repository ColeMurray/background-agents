"use client";

import { useId } from "react";
import { SafeMarkdown } from "@/components/safe-markdown";
import { ChevronDownIcon, FileIcon, LinkIcon } from "@/components/ui/icons";
import {
  formatGitHubReviewCommentLocation,
  parseGitHubDiffHunk,
  type GitHubAutofixFeedback,
  type GitHubDiffLine,
} from "@/lib/github-autofix-feedback";
import { cn } from "@/lib/utils";
import { getSafeExternalUrl } from "@/lib/urls";

type ReviewFeedback = Extract<GitHubAutofixFeedback, { kind: "review" }>;
type ReviewComment = ReviewFeedback["comments"][number];
const REVIEW_BODY_PREVIEW_CHARS = 600;
const REVIEW_BODY_PREVIEW_LINES = 14;
const COMMENT_PREVIEW_CHARS = 280;
const INITIAL_REVIEW_COMMENTS = 10;

export function GitHubAutofixFeedbackCard({
  feedback,
  messageId,
  expandedSections,
  onToggleSection,
}: {
  feedback: GitHubAutofixFeedback;
  messageId: string;
  expandedSections: ReadonlySet<string>;
  onToggleSection: (key: string) => void;
}) {
  const sourceUrl = getSafeExternalUrl(feedback.url);
  const reviewBodyKey = `${messageId}:review-body`;

  return (
    <div className="border border-border bg-card">
      <div className="border-l-2 border-accent p-3 sm:p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-accent">
              GitHub feedback
            </div>
            <h3 className="mt-1 text-sm font-semibold">
              {feedback.kind === "review" ? "Pull request review" : "Pull request comment"}
            </h3>
          </div>
          {feedback.kind === "review" && (
            <span className="text-[10px] text-muted-foreground">
              {formatCommentCount(feedback.comments.length)}
            </span>
          )}
        </div>

        {feedback.body.trim() && (
          <ReviewBody
            body={feedback.body}
            sourceUrl={sourceUrl ?? undefined}
            subject={feedback.kind === "review" ? "review" : "comment"}
            expanded={expandedSections.has(reviewBodyKey)}
            onToggle={() => onToggleSection(reviewBodyKey)}
          />
        )}
      </div>

      {feedback.kind === "review" && feedback.comments.length > 0 && (
        <ReviewThreads
          comments={feedback.comments}
          messageId={messageId}
          expandedSections={expandedSections}
          onToggleSection={onToggleSection}
        />
      )}

      {sourceUrl && (
        <div className="flex items-center justify-between gap-3 border-t border-border-muted bg-muted/40 px-3 py-2.5 sm:px-4">
          <span className="text-[10px] text-muted-foreground">Original content from GitHub</span>
          <a
            href={sourceUrl}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-accent hover:underline"
          >
            Open in GitHub <LinkIcon className="h-3 w-3" />
          </a>
        </div>
      )}
    </div>
  );
}

function ReviewBody({
  body,
  sourceUrl,
  subject,
  expanded,
  onToggle,
}: {
  body: string;
  sourceUrl?: string;
  subject: "review" | "comment";
  expanded: boolean;
  onToggle: () => void;
}) {
  const contentId = useId();
  const needsDisclosure =
    body.length > REVIEW_BODY_PREVIEW_CHARS || body.split("\n").length > REVIEW_BODY_PREVIEW_LINES;
  const preview = body
    .split("\n")
    .slice(0, REVIEW_BODY_PREVIEW_LINES)
    .join("\n")
    .slice(0, REVIEW_BODY_PREVIEW_CHARS);

  return (
    <div className="mt-3">
      <div id={contentId}>
        {needsDisclosure && !expanded ? (
          <p
            className="overflow-hidden whitespace-pre-wrap text-xs leading-5 text-muted-foreground"
            style={{
              display: "-webkit-box",
              WebkitBoxOrient: "vertical",
              WebkitLineClamp: REVIEW_BODY_PREVIEW_LINES,
            }}
          >
            {preview}
          </p>
        ) : (
          <SafeMarkdown
            content={body}
            baseUrl={sourceUrl}
            imageMode="placeholder"
            className="text-xs prose-headings:mb-2 prose-headings:mt-4 prose-headings:text-xs prose-p:text-xs prose-p:leading-5 prose-li:text-xs prose-li:leading-5"
          />
        )}
      </div>
      {needsDisclosure && (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={contentId}
          className="mt-2 text-[11px] font-semibold text-accent hover:underline"
        >
          {expanded ? "Show less" : `Show complete ${subject}`}
        </button>
      )}
    </div>
  );
}

function ReviewThreads({
  comments,
  messageId,
  expandedSections,
  onToggleSection,
}: {
  comments: ReviewFeedback["comments"];
  messageId: string;
  expandedSections: ReadonlySet<string>;
  onToggleSection: (key: string) => void;
}) {
  const commentListKey = `${messageId}:comment-list`;
  const showAll = expandedSections.has(commentListKey);
  const visibleComments = showAll ? comments : comments.slice(0, INITIAL_REVIEW_COMMENTS);

  return (
    <div className="border-t border-border-muted p-3 sm:p-4">
      <div className="mb-2 flex items-center gap-3 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        <span>{formatCommentCount(comments.length)}</span>
        <span aria-hidden="true" className="h-px flex-1 bg-border" />
      </div>
      <div className="space-y-2">
        {visibleComments.map((comment, index) => (
          <ReviewThread
            key={`${comment.url}:${index}`}
            comment={comment}
            expanded={expandedSections.has(`${messageId}:thread:${index}`)}
            onToggle={() => onToggleSection(`${messageId}:thread:${index}`)}
          />
        ))}
      </div>
      {comments.length > INITIAL_REVIEW_COMMENTS && (
        <button
          type="button"
          onClick={() => onToggleSection(commentListKey)}
          aria-expanded={showAll}
          className="mt-3 text-[11px] font-semibold text-accent hover:underline"
        >
          {showAll ? "Show fewer comments" : `Show all ${comments.length} comments`}
        </button>
      )}
    </div>
  );
}

function ReviewThread({
  comment,
  expanded,
  onToggle,
}: {
  comment: ReviewComment;
  expanded: boolean;
  onToggle: () => void;
}) {
  const contentId = useId();
  const location = formatGitHubReviewCommentLocation(comment);
  const threadUrl = getSafeExternalUrl(comment.url);

  return (
    <article className="border border-border bg-card">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={expanded ? contentId : undefined}
        aria-label={`${expanded ? "Collapse" : "Expand"} review comment on ${comment.path}${location ? ` ${location}` : ""}`}
        className="flex w-full items-start gap-3 p-3 text-left transition-colors hover:bg-muted/50"
      >
        <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center bg-accent-muted text-accent">
          <FileIcon className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2 font-mono text-[10px] text-muted-foreground">
            <span className="truncate">{comment.path}</span>
            {location && <span className="shrink-0">{location}</span>}
          </div>
        </div>
        <ChevronDownIcon
          className={cn(
            "mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-180"
          )}
        />
      </button>

      {!expanded && comment.body.trim() && (
        <p className="line-clamp-2 whitespace-pre-wrap px-3 pb-3 pl-12 text-xs leading-5 text-muted-foreground">
          {comment.body.slice(0, COMMENT_PREVIEW_CHARS)}
        </p>
      )}

      {expanded && (
        <div id={contentId} className="border-t border-border-muted">
          {comment.diffHunk && (
            <DiffHunk
              path={comment.path}
              diffHunk={comment.diffHunk}
              truncated={comment.diffHunkTruncated === true}
            />
          )}
          <div className="border-l-2 border-accent px-3 py-3 sm:ml-4 sm:px-4">
            {comment.body.trim() && (
              <SafeMarkdown
                content={comment.body}
                baseUrl={threadUrl ?? undefined}
                imageMode="placeholder"
                className="text-xs prose-p:text-xs prose-p:leading-5"
              />
            )}
            {threadUrl && (
              <a
                href={threadUrl}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="mt-3 inline-flex items-center gap-1.5 text-[11px] font-semibold text-accent hover:underline"
              >
                Open original thread <LinkIcon className="h-3 w-3" />
              </a>
            )}
          </div>
        </div>
      )}
    </article>
  );
}

function DiffHunk({
  path,
  diffHunk,
  truncated,
}: {
  path: string;
  diffHunk: string;
  truncated: boolean;
}) {
  const lines = parseGitHubDiffHunk(diffHunk);

  return (
    <div
      role="region"
      aria-label={`Diff context for ${path}`}
      tabIndex={0}
      className="max-h-72 overflow-auto bg-muted/50 font-mono text-[10px] leading-5 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      {lines.map((line, index) => (
        <DiffLine key={`${index}:${line.content}`} line={line} />
      ))}
      {truncated && (
        <div className="border-t border-border-muted px-3 py-1 text-muted-foreground">
          Diff context truncated by Open Inspect
        </div>
      )}
    </div>
  );
}

function DiffLine({ line }: { line: GitHubDiffLine }) {
  if (line.type === "hunk") {
    return (
      <div className="whitespace-pre border-y border-border-muted bg-accent-muted px-3 text-accent">
        {line.content}
      </div>
    );
  }

  const marker = line.type === "added" ? "+" : line.type === "removed" ? "-" : " ";
  return (
    <div
      className={cn(
        "flex min-w-max",
        line.type === "added" && "bg-success-muted",
        line.type === "removed" && "bg-destructive-muted",
        line.type === "meta" && "text-muted-foreground"
      )}
    >
      <LineNumber value={line.oldLine} />
      <LineNumber value={line.newLine} />
      <span
        className={cn(
          "w-6 shrink-0 select-none text-center",
          line.type === "added" && "text-success",
          line.type === "removed" && "text-destructive"
        )}
      >
        {marker}
      </span>
      <code className="whitespace-pre pr-4 text-foreground">{line.content || " "}</code>
    </div>
  );
}

function LineNumber({ value }: { value: number | null }) {
  return (
    <span className="w-10 shrink-0 select-none border-r border-border px-1.5 text-right text-secondary-foreground">
      {value}
    </span>
  );
}

function formatCommentCount(count: number): string {
  return `${count} inline ${count === 1 ? "comment" : "comments"}`;
}
