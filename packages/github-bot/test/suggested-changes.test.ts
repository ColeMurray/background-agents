import { describe, it, expect } from "vitest";
import { reviewCommentPayloadSchema, type ReviewCommentPayload } from "../src/payload-schemas";
import {
  buildThreadSuggestionRules,
  resolveThreadSuggestionTarget,
  shellQuote,
} from "../src/suggested-changes";

const basePayload = {
  action: "created",
  pull_request: {
    number: 42,
    title: "Add caching",
    head: { ref: "feature/cache", sha: "head123" },
    base: { ref: "main" },
  },
  comment: {
    id: 200,
    body: "@bot suggest a fix",
    path: "src/cache.ts",
    diff_hunk: "@@ -10,3 +10,5 @@\n+const cache = new Map();",
    user: { login: "carol" },
  },
  repository: { id: 99, owner: { login: "acme" }, name: "widgets", private: false },
  sender: { login: "carol", id: 1003, avatar_url: "https://avatars.githubusercontent.com/u/1003" },
};

function parseComment(anchor: Record<string, unknown>): ReviewCommentPayload["comment"] {
  return reviewCommentPayloadSchema.parse({
    ...basePayload,
    comment: { ...basePayload.comment, ...anchor },
  }).comment;
}

const singleLine = {
  commit_id: "d34db33fd34db33fd34db33fd34db33fd34db33f",
  subject_type: "line",
  line: 12,
  side: "RIGHT",
  start_line: null,
  start_side: null,
};

describe("reviewCommentPayloadSchema anchor fields", () => {
  it("still accepts payloads without anchor fields", () => {
    const comment = parseComment({});
    expect(comment.line).toBeUndefined();
    expect(resolveThreadSuggestionTarget(comment)).toEqual({
      kind: "unavailable",
      reason: "missing_anchor",
    });
  });

  it("degrades unexpected anchor values instead of rejecting the mention", () => {
    const parsed = reviewCommentPayloadSchema.safeParse({
      ...basePayload,
      comment: {
        ...basePayload.comment,
        line: "12",
        start_line: -1,
        side: 7,
        commit_id: 5,
        in_reply_to_id: "x",
      },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.comment.line).toBeUndefined();
    expect(parsed.data.comment.in_reply_to_id).toBeUndefined();
    expect(resolveThreadSuggestionTarget(parsed.data.comment).kind).toBe("unavailable");
  });
});

describe("resolveThreadSuggestionTarget", () => {
  it("targets the single commented line", () => {
    expect(resolveThreadSuggestionTarget(parseComment(singleLine))).toEqual({
      kind: "lines",
      commitId: "d34db33fd34db33fd34db33fd34db33fd34db33f",
      startLine: 12,
      endLine: 12,
    });
  });

  it("targets the whole range of a multi-line thread", () => {
    const comment = parseComment({ ...singleLine, start_line: 10, start_side: "RIGHT" });
    expect(resolveThreadSuggestionTarget(comment)).toEqual({
      kind: "lines",
      commitId: "d34db33fd34db33fd34db33fd34db33fd34db33f",
      startLine: 10,
      endLine: 12,
    });
  });

  it.each([
    ["outdated threads", { ...singleLine, line: null }, "outdated"],
    ["file-level comments", { ...singleLine, subject_type: "file", line: null }, "file_comment"],
    ["base-side lines", { ...singleLine, side: "LEFT" }, "base_side"],
    [
      "ranges starting on base-side lines",
      { ...singleLine, start_line: 10, start_side: "LEFT" },
      "base_side",
    ],
    ["ranges without a start side", { ...singleLine, start_line: 10 }, "missing_anchor"],
    ["comments without a side", { ...singleLine, side: null }, "missing_anchor"],
    ["comments without a commit", { ...singleLine, commit_id: undefined }, "missing_anchor"],
    [
      "commits that are not a hex SHA",
      { ...singleLine, commit_id: "main; rm -rf /" },
      "missing_anchor",
    ],
    ["inverted ranges", { ...singleLine, start_line: 13, start_side: "RIGHT" }, "missing_anchor"],
  ])("refuses %s", (_name, anchor, reason) => {
    expect(resolveThreadSuggestionTarget(parseComment(anchor))).toEqual({
      kind: "unavailable",
      reason,
    });
  });
});

describe("shellQuote", () => {
  it("single-quotes values and escapes embedded single quotes", () => {
    expect(shellQuote("src/a b.ts")).toBe("'src/a b.ts'");
    expect(shellQuote("it's $HOME `x`")).toBe(`'it'\\''s $HOME \`x\`'`);
  });
});

describe("buildThreadSuggestionRules", () => {
  it("states the fixed range and how to print exactly those lines", () => {
    const rules = buildThreadSuggestionRules("src/it's.ts", {
      kind: "lines",
      commitId: "d34db33fd34db33fd34db33fd34db33fd34db33f",
      startLine: 10,
      endLine: 12,
    });
    expect(rules).toContain("replaces lines 10-12 of `src/it's.ts`");
    expect(rules).toContain("commit d34db33fd34db33fd34db33fd34db33fd34db33f");
    expect(rules).toContain(
      `git fetch --quiet origin d34db33fd34db33fd34db33fd34db33fd34db33f && git show 'd34db33fd34db33fd34db33fd34db33fd34db33f:src/it'\\''s.ts' | sed -n '10,12p'`
    );
  });

  it("names a single line without a range", () => {
    const rules = buildThreadSuggestionRules("src/a.ts", {
      kind: "lines",
      commitId: "c",
      startLine: 4,
      endLine: 4,
    });
    expect(rules).toContain("replaces line 4 of `src/a.ts`");
  });

  it("forbids suggestions in replies to threads without a usable range", () => {
    const rules = buildThreadSuggestionRules("src/a.ts", {
      kind: "unavailable",
      reason: "outdated",
    });
    expect(rules).toContain("Do not put a suggestion block in a reply to this review thread");
    expect(rules).toContain("the thread is outdated");
    expect(rules).not.toContain("git show");
  });
});
