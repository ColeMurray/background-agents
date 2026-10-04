/**
 * GitHub suggested changes: review comments whose ```suggestion block the PR
 * author can commit with one click. Applying one replaces the comment's whole
 * line range (`start_line`..`line`, RIGHT side, at the comment's commit) with
 * the block's contents, so a wrong range or a stale copy of the original lines
 * silently corrupts the file. Everything about the range that the webhook can
 * tell us is decided here in code; the agent only writes the replacement text.
 */
import type { ReviewCommentPayload } from "./payload-schemas";

export type ThreadSuggestionUnavailableReason =
  | "file_comment"
  | "outdated"
  | "base_side"
  | "missing_anchor";

/** What a suggestion block in a reply to a review thread would replace. */
export type ThreadSuggestionTarget =
  | { kind: "lines"; commitId: string; startLine: number; endLine: number }
  | { kind: "unavailable"; reason: ThreadSuggestionUnavailableReason };

const UNAVAILABLE_REASON_TEXT: Record<ThreadSuggestionUnavailableReason, string> = {
  file_comment: "it is a file-level comment with no line range",
  outdated: "the thread is outdated, so GitHub no longer maps it to lines in the current diff",
  base_side: "it is anchored to removed (base-side) lines, which a suggestion cannot change",
  missing_anchor: "GitHub did not report a usable line range for it",
};

/**
 * Replies inherit their thread's range, which GitHub reports on every comment
 * in the thread. GitHub sends `line: null` once the thread is outdated.
 */
export function resolveThreadSuggestionTarget(
  comment: ReviewCommentPayload["comment"]
): ThreadSuggestionTarget {
  const unavailable = (reason: ThreadSuggestionUnavailableReason): ThreadSuggestionTarget => ({
    kind: "unavailable",
    reason,
  });
  if (comment.subject_type === "file") return unavailable("file_comment");
  if (comment.line === null) return unavailable("outdated");
  if (comment.line === undefined) return unavailable("missing_anchor");
  if (comment.side == null) return unavailable("missing_anchor");
  if (comment.side === "LEFT") return unavailable("base_side");
  if (comment.start_line != null) {
    if (comment.start_side == null) return unavailable("missing_anchor");
    if (comment.start_side === "LEFT") return unavailable("base_side");
  }
  const startLine = comment.start_line ?? comment.line;
  if (!comment.commit_id || startLine > comment.line) return unavailable("missing_anchor");
  return { kind: "lines", commitId: comment.commit_id, startLine, endLine: comment.line };
}

/** POSIX single-quoting, so webhook-supplied paths never reach the shell unquoted. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

// Writes the blob to a file first: in `git show | sed`, sed would succeed on empty input after a
// failed read, and an empty "original" turns a suggestion into a deletion.
function buildReadLinesCommand(commitId: string, objectArg: string, range: string): string {
  return `f=$(mktemp) && git fetch --quiet --depth=1 origin ${commitId} && git show ${objectArg} > "$f" && sed -n '${range}p' "$f"`;
}

const READ_FAILURE_RULE =
  "If that command fails or prints fewer lines than the range, do not leave that suggestion.";

/** Rules for writing any suggestion block, whichever comment carries it. */
export function buildSuggestionFormatRules(): string {
  return `- A suggestion is a fenced code block with the info string \`suggestion\`, placed after your
  explanation in the comment body. Committing it replaces every line of the comment's range with
  the block's contents, so the block must hold the complete replacement for exactly those lines:
  every line you keep, with its original indentation. An empty block deletes the lines.
- Copy the lines you replace from the commit the comment is anchored to, never from memory, the
  working tree, or the diff view. Your checkout may be a different branch or commit.
- Only suggest a fix that is complete on its own. If it also needs edits outside the range (other
  hunks, other files, new imports), describe it in prose instead.
- Use at most one suggestion block per comment, and never let two suggestions' ranges overlap.
- If the replacement contains a run of three or more backticks, fence it with more backticks than
  the longest run (for example \`\`\`\`suggestion).`;
}

/**
 * How to read the lines a comment in a new review pinned to `commitId` would replace. PR authors
 * control paths, so the agent never types one into a command; it reads it from `pathFile`.
 */
export function buildReviewSuggestionAnchorRules(commitId: string, pathFile: string): string {
  return `- For a comment in a review pinned to commit ${commitId}, write its path file (see the review
  steps), then print the exact lines its range covers with:
  ${buildReadLinesCommand(commitId, `"${commitId}:$(cat ${pathFile})"`, "<start_line>,<line>")}
  ${READ_FAILURE_RULE}`;
}

/** Rules for a suggestion in a reply to the review thread that triggered the request. */
export function buildThreadSuggestionRules(path: string, target: ThreadSuggestionTarget): string {
  if (target.kind === "unavailable") {
    return `- Do not put a suggestion block in a reply to this review thread: ${UNAVAILABLE_REASON_TEXT[target.reason]}.`;
  }
  const { commitId, startLine, endLine } = target;
  const range = startLine === endLine ? `line ${endLine}` : `lines ${startLine}-${endLine}`;
  return `- A suggestion block in a reply to this review thread replaces ${range} of \`${path}\` at
  commit ${commitId}. GitHub fixes a reply's range to its thread, so you cannot change it. Print
  those exact lines with:
  ${buildReadLinesCommand(commitId, shellQuote(`${commitId}:${path}`), `${startLine},${endLine}`)}
  ${READ_FAILURE_RULE}
- In this thread you may also answer a question with a suggestion instead of describing the fix in
  prose, when the fix is confined to exactly those lines.`;
}
