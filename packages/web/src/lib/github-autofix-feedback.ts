import {
  githubAutofixFeedbackSchema,
  MAX_GITHUB_AUTOFIX_PROMPT_BYTES,
  type GitHubAutofixFeedback,
  type GitHubAutofixReviewComment,
} from "@open-inspect/shared/types/github-autofix";

export type { GitHubAutofixFeedback, GitHubAutofixReviewComment };

const FEEDBACK_DATA_OPEN = "<github_feedback_data>";
const FEEDBACK_DATA_CLOSE = "</github_feedback_data>";

export type GitHubDiffLine = {
  type: "context" | "added" | "removed" | "hunk" | "meta";
  content: string;
  oldLine: number | null;
  newLine: number | null;
};

export function parseGitHubAutofixFeedback(
  content: string,
  kind: GitHubAutofixFeedback["kind"]
): GitHubAutofixFeedback | null {
  if (isGitHubAutofixPromptOverLimit(content)) return null;

  const openingIndex = content.indexOf(FEEDBACK_DATA_OPEN);
  if (openingIndex === -1) return null;

  const payloadStart = openingIndex + FEEDBACK_DATA_OPEN.length;
  const closingIndex = content.indexOf(FEEDBACK_DATA_CLOSE, payloadStart);
  if (closingIndex === -1) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(content.slice(payloadStart, closingIndex).trim());
  } catch {
    return null;
  }

  const parsed = githubAutofixFeedbackSchema.safeParse(normalizeLegacyFeedback(payload, kind));
  return parsed.success ? parsed.data : null;
}

function normalizeLegacyFeedback(payload: unknown, kind: GitHubAutofixFeedback["kind"]): unknown {
  if (typeof payload !== "object" || payload === null) return payload;
  if (kind === "pr_comment") return { ...payload, version: 1, kind };

  const comments = Reflect.get(payload, "comments");
  return {
    ...payload,
    version: 1,
    kind,
    comments: Array.isArray(comments)
      ? comments.map((comment) =>
          typeof comment === "object" && comment !== null
            ? {
                originalLine: null,
                originalStartLine: null,
                side: null,
                startSide: null,
                diffHunkTruncated: false,
                ...comment,
              }
            : comment
        )
      : comments,
  };
}

export function parseGitHubDiffHunk(diffHunk: string): GitHubDiffLine[] {
  let oldLine: number | null = null;
  let newLine: number | null = null;

  return diffHunk.split("\n").map((rawLine) => {
    const hunk = rawLine.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      const nextOldLine = Number(hunk[1]);
      const nextNewLine = Number(hunk[2]);
      if (!isSafeDiffLine(nextOldLine) || !isSafeDiffLine(nextNewLine)) {
        oldLine = null;
        newLine = null;
        return { type: "meta", content: rawLine, oldLine: null, newLine: null };
      }
      oldLine = nextOldLine;
      newLine = nextNewLine;
      return { type: "hunk", content: rawLine, oldLine: null, newLine: null };
    }

    if (rawLine.startsWith("+")) {
      const line = { type: "added" as const, content: rawLine.slice(1), oldLine: null, newLine };
      newLine = incrementDiffLine(newLine);
      return line;
    }

    if (rawLine.startsWith("-")) {
      const line = { type: "removed" as const, content: rawLine.slice(1), oldLine, newLine: null };
      oldLine = incrementDiffLine(oldLine);
      return line;
    }

    if (rawLine.startsWith(" ")) {
      const line = {
        type: "context" as const,
        content: rawLine.slice(1),
        oldLine,
        newLine,
      };
      oldLine = incrementDiffLine(oldLine);
      newLine = incrementDiffLine(newLine);
      return line;
    }

    return { type: "meta", content: rawLine, oldLine: null, newLine: null };
  });
}

export function formatGitHubAutofixFeedbackMarkdown(feedback: GitHubAutofixFeedback): string {
  if (feedback.kind === "pr_comment") return feedback.body;

  const sections = feedback.body ? [feedback.body] : [];
  for (const comment of feedback.comments) {
    const path = formatMarkdownCode(JSON.stringify(comment.path));
    const location = formatGitHubReviewCommentLocation(comment);
    sections.push(
      `### ${path}${location ? ` ${location}` : ""}\n\n${comment.body}\n\n${comment.url}`
    );
  }
  return sections.join("\n\n---\n\n");
}

export function formatGitHubReviewCommentLocation(
  comment: Pick<
    GitHubAutofixReviewComment,
    "line" | "startLine" | "originalLine" | "originalStartLine" | "side" | "startSide"
  >
): string | null {
  const original = comment.line === null && comment.originalLine != null;
  const line = original ? comment.originalLine : comment.line;
  if (line == null) return null;

  const startLine = original ? comment.originalStartLine : comment.startLine;
  const prefix = original ? "Original " : "";
  const crossSide =
    comment.startSide != null && comment.side != null && comment.startSide !== comment.side;
  if (startLine != null && (startLine !== line || crossSide)) {
    if (comment.startSide && comment.side && comment.startSide !== comment.side) {
      return `${prefix}L${startLine} ${comment.startSide}-L${line} ${comment.side}`;
    }
    return `${prefix}L${startLine}-L${line}${comment.side ? ` · ${comment.side}` : ""}`;
  }
  return `${prefix}L${line}${comment.side ? ` · ${comment.side}` : ""}`;
}

export function isGitHubAutofixPromptOverLimit(content: string): boolean {
  if (content.length > MAX_GITHUB_AUTOFIX_PROMPT_BYTES) return true;
  return new TextEncoder().encode(content).byteLength > MAX_GITHUB_AUTOFIX_PROMPT_BYTES;
}

function isSafeDiffLine(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function incrementDiffLine(value: number | null): number | null {
  return value !== null && value < Number.MAX_SAFE_INTEGER ? value + 1 : null;
}

function formatMarkdownCode(value: string): string {
  const longestRun = Math.max(0, ...(value.match(/`+/g) ?? []).map((run) => run.length));
  const delimiter = "`".repeat(longestRun + 1);
  return `${delimiter}${value}${delimiter}`;
}
