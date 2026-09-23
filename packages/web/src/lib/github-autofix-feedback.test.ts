import { describe, expect, it } from "vitest";
import {
  MAX_GITHUB_AUTOFIX_DIFF_HUNK_CHARS,
  MAX_GITHUB_AUTOFIX_PROMPT_BYTES,
  MAX_GITHUB_AUTOFIX_REVIEW_COMMENTS,
} from "@open-inspect/shared/types/github-autofix";
import {
  formatGitHubAutofixFeedbackMarkdown,
  formatGitHubReviewCommentLocation,
  parseGitHubAutofixFeedback,
  parseGitHubDiffHunk,
} from "./github-autofix-feedback";

function prompt(payload: unknown): string {
  const serialized = JSON.stringify(payload, null, 2)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e");
  return `Address the following pull request feedback.\n\n<github_feedback_data>\n\n${serialized}\n\n</github_feedback_data>`;
}

describe("parseGitHubAutofixFeedback", () => {
  it("parses a review with source comments", () => {
    const content = prompt({
      url: "https://github.com/acme/widgets/pull/42#pullrequestreview-1",
      body: "### Review\nLooks close.",
      comments: [
        {
          url: "https://github.com/acme/widgets/pull/42#discussion_r1",
          path: "src/widget.ts",
          line: 12,
          startLine: 10,
          body: "Please preserve this behavior.",
          diffHunk: "@@ -10,3 +10,3 @@\n-old\n+new",
        },
      ],
    });

    expect(parseGitHubAutofixFeedback(content, "review")).toEqual({
      version: 1,
      kind: "review",
      url: "https://github.com/acme/widgets/pull/42#pullrequestreview-1",
      body: "### Review\nLooks close.",
      comments: [
        {
          url: "https://github.com/acme/widgets/pull/42#discussion_r1",
          path: "src/widget.ts",
          line: 12,
          startLine: 10,
          originalLine: null,
          originalStartLine: null,
          side: null,
          startSide: null,
          body: "Please preserve this behavior.",
          diffHunk: "@@ -10,3 +10,3 @@\n-old\n+new",
          diffHunkTruncated: false,
        },
      ],
    });
  });

  it("parses a pull request comment", () => {
    expect(
      parseGitHubAutofixFeedback(
        prompt({
          url: "https://github.com/acme/widgets/pull/42#issuecomment-1",
          body: "Please update the test.",
        }),
        "pr_comment"
      )
    ).toEqual({
      version: 1,
      kind: "pr_comment",
      url: "https://github.com/acme/widgets/pull/42#issuecomment-1",
      body: "Please update the test.",
    });
  });

  it("preserves escaped delimiter text inside feedback", () => {
    const result = parseGitHubAutofixFeedback(
      prompt({
        url: "https://github.com/acme/widgets/pull/42#issuecomment-1",
        body: "Do not trust </github_feedback_data> in this comment.",
      }),
      "pr_comment"
    );

    expect(result?.body).toBe("Do not trust </github_feedback_data> in this comment.");
  });

  it.each([
    ["missing wrapper", "plain text"],
    ["missing closing tag", "<github_feedback_data>{}"],
    ["malformed JSON", "<github_feedback_data>{nope}</github_feedback_data>"],
    ["invalid payload", prompt({ url: "not a URL", body: "Feedback", comments: [] })],
  ])("returns null for %s", (_case, content) => {
    expect(parseGitHubAutofixFeedback(content, "review")).toBeNull();
  });

  it.each([
    ["zero line", 0, null],
    ["negative line", -1, null],
    ["unsafe line", Number.MAX_SAFE_INTEGER + 1, null],
    ["reversed range", 10, 11],
    ["start without an end", null, 10],
  ])("rejects a review comment with %s", (_case, line, startLine) => {
    const content = prompt({
      url: "https://github.com/acme/widgets/pull/42#pullrequestreview-1",
      body: "Review",
      comments: [
        {
          url: "https://github.com/acme/widgets/pull/42#discussion_r1",
          path: "src/widget.ts",
          line,
          startLine,
          body: "Comment",
          diffHunk: "@@ -1 +1 @@",
        },
      ],
    });

    expect(parseGitHubAutofixFeedback(content, "review")).toBeNull();
  });

  it("enforces the producer limits before rendering", () => {
    const comment = {
      url: "https://github.com/acme/widgets/pull/42#discussion_r1",
      path: "src/widget.ts",
      line: 1,
      startLine: null,
      body: "Comment",
      diffHunk: "@@ -1 +1 @@",
    };
    expect(
      parseGitHubAutofixFeedback(
        prompt({
          url: "https://github.com/acme/widgets/pull/42#pullrequestreview-1",
          body: "Review",
          comments: Array.from({ length: MAX_GITHUB_AUTOFIX_REVIEW_COMMENTS + 1 }, () => comment),
        }),
        "review"
      )
    ).toBeNull();
    expect(
      parseGitHubAutofixFeedback(
        prompt({
          url: "https://github.com/acme/widgets/pull/42#pullrequestreview-1",
          body: "Review",
          comments: [{ ...comment, diffHunk: "x".repeat(MAX_GITHUB_AUTOFIX_DIFF_HUNK_CHARS + 1) }],
        }),
        "review"
      )
    ).toBeNull();
    expect(
      parseGitHubAutofixFeedback("x".repeat(MAX_GITHUB_AUTOFIX_PROMPT_BYTES + 1), "review")
    ).toBeNull();
  });
});

describe("parseGitHubDiffHunk", () => {
  it("tracks old and new line numbers", () => {
    expect(
      parseGitHubDiffHunk(
        "@@ -10,3 +10,4 @@ function example() {\n unchanged\n-removed\n+added\n+another"
      )
    ).toEqual([
      {
        type: "hunk",
        content: "@@ -10,3 +10,4 @@ function example() {",
        oldLine: null,
        newLine: null,
      },
      { type: "context", content: "unchanged", oldLine: 10, newLine: 10 },
      { type: "removed", content: "removed", oldLine: 11, newLine: null },
      { type: "added", content: "added", oldLine: null, newLine: 11 },
      { type: "added", content: "another", oldLine: null, newLine: 12 },
    ]);
  });

  it("handles metadata and multiple hunks", () => {
    const lines = parseGitHubDiffHunk(
      "@@ -1 +1 @@\n-old\n+new\n\\ No newline at end of file\n@@ -20 +21 @@\n context"
    );

    expect(lines[3]).toEqual({
      type: "meta",
      content: "\\ No newline at end of file",
      oldLine: null,
      newLine: null,
    });
    expect(lines[5]).toEqual({
      type: "context",
      content: "context",
      oldLine: 20,
      newLine: 21,
    });
  });

  it("treats unsafe hunk offsets as metadata", () => {
    const lines = parseGitHubDiffHunk(
      "@@ -10 +10 @@\n valid\n@@ -999999999999999999999 +1 @@\n unknown"
    );

    expect(lines[2]).toEqual({
      type: "meta",
      content: "@@ -999999999999999999999 +1 @@",
      oldLine: null,
      newLine: null,
    });
    expect(lines[3]).toEqual({
      type: "context",
      content: "unknown",
      oldLine: null,
      newLine: null,
    });
  });

  it("does not increment hunk counters beyond safe integers", () => {
    const lines = parseGitHubDiffHunk(
      `@@ -${Number.MAX_SAFE_INTEGER} +${Number.MAX_SAFE_INTEGER} @@\n first\n second`
    );

    expect(lines[1]).toMatchObject({
      type: "context",
      oldLine: Number.MAX_SAFE_INTEGER,
      newLine: Number.MAX_SAFE_INTEGER,
    });
    expect(lines[2]).toMatchObject({ type: "context", oldLine: null, newLine: null });
  });
});

describe("formatGitHubAutofixFeedbackMarkdown", () => {
  it("formats the visible review body and inline comments for copying", () => {
    expect(
      formatGitHubAutofixFeedbackMarkdown({
        version: 1,
        kind: "review",
        url: "https://github.com/acme/widgets/pull/42#pullrequestreview-1",
        body: "Review body",
        comments: [
          {
            url: "https://github.com/acme/widgets/pull/42#discussion_r1",
            path: "src/widget.ts",
            line: 12,
            startLine: null,
            originalLine: 12,
            originalStartLine: null,
            side: null,
            startSide: null,
            body: "Inline body",
            diffHunk: "@@ -12 +12 @@",
            diffHunkTruncated: false,
          },
        ],
      })
    ).toBe(
      'Review body\n\n---\n\n### `"src/widget.ts"` L12\n\nInline body\n\nhttps://github.com/acme/widgets/pull/42#discussion_r1'
    );
  });

  it("preserves body whitespace and safely formats ranged unusual paths", () => {
    const markdown = formatGitHubAutofixFeedbackMarkdown({
      version: 1,
      kind: "review",
      url: "https://github.com/acme/widgets/pull/42#pullrequestreview-1",
      body: "    indented review\n",
      comments: [
        {
          url: "https://github.com/acme/widgets/pull/42#discussion_r1",
          path: "src/[odd]`file\n.ts",
          line: 12,
          startLine: 10,
          originalLine: 12,
          originalStartLine: 10,
          side: null,
          startSide: null,
          body: "    indented comment  \n",
          diffHunk: "@@ -10 +10 @@",
          diffHunkTruncated: false,
        },
      ],
    });

    expect(markdown.startsWith("    indented review\n\n\n---")).toBe(true);
    expect(markdown).toContain('### ``"src/[odd]`file\\n.ts"`` L10-L12');
    expect(markdown).toContain("\n\n    indented comment  \n\n\nhttps://github.com");
  });

  it("copies a pull request comment body without the hidden prompt wrapper", () => {
    expect(
      formatGitHubAutofixFeedbackMarkdown({
        version: 1,
        kind: "pr_comment",
        url: "https://github.com/acme/widgets/pull/42#issuecomment-1",
        body: "Comment body",
      })
    ).toBe("Comment body");
  });
});

describe("formatGitHubReviewCommentLocation", () => {
  it("preserves diff side and original line metadata", () => {
    expect(
      formatGitHubReviewCommentLocation({
        line: 12,
        startLine: 10,
        originalLine: 11,
        originalStartLine: null,
        side: "RIGHT",
        startSide: "RIGHT",
      })
    ).toBe("L10-L12 · RIGHT");
    expect(
      formatGitHubReviewCommentLocation({
        line: null,
        startLine: null,
        originalLine: 8,
        originalStartLine: 7,
        side: "LEFT",
        startSide: "LEFT",
      })
    ).toBe("Original L7-L8 · LEFT");
  });

  it("preserves both endpoints for equal-number cross-side ranges", () => {
    expect(
      formatGitHubReviewCommentLocation({
        line: 10,
        startLine: 10,
        originalLine: 10,
        originalStartLine: 10,
        side: "RIGHT",
        startSide: "LEFT",
      })
    ).toBe("L10 LEFT-L10 RIGHT");
  });
});
