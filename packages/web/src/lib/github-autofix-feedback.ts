import { z } from "zod";
import {
  MAX_GITHUB_AUTOFIX_DIFF_HUNK_CHARS,
  MAX_GITHUB_AUTOFIX_PROMPT_BYTES,
  MAX_GITHUB_AUTOFIX_REVIEW_COMMENTS,
} from "@open-inspect/shared/types/github-autofix";

const FEEDBACK_DATA_OPEN = "<github_feedback_data>";
const FEEDBACK_DATA_CLOSE = "</github_feedback_data>";

const feedbackBaseSchema = z.object({
  url: z.url(),
  body: z.string(),
});

const sourceLineSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable();
const optionalSourceLineSchema = sourceLineSchema.optional();
const sideSchema = z.enum(["LEFT", "RIGHT"]).nullable().optional();

const reviewCommentSchema = z
  .object({
    url: z.url(),
    path: z.string(),
    line: sourceLineSchema,
    startLine: sourceLineSchema,
    originalLine: optionalSourceLineSchema,
    originalStartLine: optionalSourceLineSchema,
    side: sideSchema,
    startSide: sideSchema,
    body: z.string(),
    diffHunk: z.string().max(MAX_GITHUB_AUTOFIX_DIFF_HUNK_CHARS),
    diffHunkTruncated: z.boolean().optional(),
  })
  .refine(
    ({ line, startLine }) => startLine === null || (line !== null && startLine <= line),
    "Expected startLine to precede line"
  )
  .refine(
    ({ originalLine, originalStartLine }) =>
      originalStartLine == null || (originalLine != null && originalStartLine <= originalLine),
    "Expected originalStartLine to precede originalLine"
  );

const reviewFeedbackSchema = feedbackBaseSchema.extend({
  comments: z.array(reviewCommentSchema).max(MAX_GITHUB_AUTOFIX_REVIEW_COMMENTS),
});

export type GitHubAutofixFeedback =
  | ({ kind: "pr_comment" } & z.infer<typeof feedbackBaseSchema>)
  | ({ kind: "review" } & z.infer<typeof reviewFeedbackSchema>);
export type GitHubAutofixReviewComment = Extract<
  GitHubAutofixFeedback,
  { kind: "review" }
>["comments"][number];

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

  if (kind === "review") {
    const parsed = reviewFeedbackSchema.safeParse(payload);
    return parsed.success ? { kind, ...parsed.data } : null;
  }

  const parsed = feedbackBaseSchema.safeParse(payload);
  return parsed.success ? { kind, ...parsed.data } : null;
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
  if (startLine != null && startLine !== line) {
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
