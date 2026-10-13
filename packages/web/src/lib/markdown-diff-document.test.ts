import { describe, expect, it } from "vitest";
import {
  DIFF_UNIFIED_CONTEXT_LINES,
  isMarkdownPreviewPath,
  reconstructMarkdownDocument,
  trailingContextHidesDocumentEnd,
} from "./markdown-diff-document";

describe("isMarkdownPreviewPath", () => {
  it.each(["README.md", "docs/Guide.MD", "notes.markdown", "docs/Plan.MARKDOWN"])(
    "accepts %s",
    (path) => {
      expect(isMarkdownPreviewPath(path)).toBe(true);
    }
  );

  it.each(["src/app.ts", "README.mdx", "archive.md.bak", "README", ".md", "docs/md"])(
    "rejects %s",
    (path) => {
      expect(isMarkdownPreviewPath(path)).toBe(false);
    }
  );
});

describe("reconstructMarkdownDocument", () => {
  it("rebuilds the whole resulting document and drops deletions, headers, and hunk markers", () => {
    const patch = [
      "diff --git a/docs/guide.md b/docs/guide.md",
      "index eabd299d71c73460e78ca82f533bb848bc5ca834..b68e4b665e7a718b3ee1ffd14b1765e9496d1f3d 100644",
      "--- a/docs/guide.md",
      "+++ b/docs/guide.md",
      "@@ -1,8 +1,9 @@",
      " # Title",
      " ",
      " unchanged before",
      "-removed sentence",
      "+edited sentence",
      " ",
      " - a list item whose text starts with a hyphen",
      "+- a new list item",
      " ",
      " See [docs](https://example.com/docs).",
      "",
    ].join("\n");

    expect(reconstructMarkdownDocument(patch)).toEqual({
      status: "document",
      content: [
        "# Title",
        "",
        "unchanged before",
        "edited sentence",
        "",
        "- a list item whose text starts with a hyphen",
        "- a new list item",
        "",
        "See [docs](https://example.com/docs).",
        "",
      ].join("\n"),
    });
  });

  it("keeps a renamed file's resulting text, including a line that starts with a plus", () => {
    const patch = [
      "diff --git a/old.md b/docs/renamed.md",
      "similarity index 70%",
      "rename from old.md",
      "rename to docs/renamed.md",
      "index a7e034859263d17d11e3b50af3c88d568731ea5a..33b28bb11da32d4e033f1d9984eafeca23aabf6d 100644",
      "--- a/old.md",
      "+++ b/docs/renamed.md",
      "@@ -1,3 +1,4 @@",
      " # Title",
      " ",
      "-old line",
      "+new line",
      "+++ not a diff header",
      "",
    ].join("\n");

    expect(reconstructMarkdownDocument(patch)).toEqual({
      status: "document",
      content: "# Title\n\nnew line\n++ not a diff header\n",
    });
  });

  it("reconstructs an added file, including one with no trailing newline", () => {
    const added = [
      "diff --git a/UNTRACKED.md b/UNTRACKED.md",
      "new file mode 100644",
      "index 0000000000000000000000000000000000000000..95d09f2e70d1f5f5f5f5f5f5f5f5f5f5f5f5f5f5",
      "--- /dev/null",
      "+++ b/UNTRACKED.md",
      "@@ -0,0 +1,2 @@",
      "+# Untracked",
      "+full body",
      "",
    ].join("\n");
    const noNewline = [
      "diff --git a/docs/nonew.md b/docs/nonew.md",
      "index b6fc4c620b67b19709573a08d22684fb4b65b6ea..95d09f2e70d1f5f5f5f5f5f5f5f5f5f5f5f5f5f5 100644",
      "--- a/docs/nonew.md",
      "+++ b/docs/nonew.md",
      "@@ -1 +1 @@",
      "-hello",
      "\\ No newline at end of file",
      "+hello world",
      "\\ No newline at end of file",
    ].join("\n");

    expect(reconstructMarkdownDocument(added)).toEqual({
      status: "document",
      content: "# Untracked\nfull body\n",
    });
    expect(reconstructMarkdownDocument(noNewline)).toEqual({
      status: "document",
      content: "hello world",
    });
  });

  it("treats a new empty blob and a file whose contents were removed as empty documents", () => {
    const createdEmpty = [
      "diff --git a/docs/empty.md b/docs/empty.md",
      "new file mode 100644",
      "index 0000000000000000000000000000000000000000..e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",
      "",
    ].join("\n");
    const becameEmpty = [
      "diff --git a/docs/nonew.md b/docs/nonew.md",
      "index b6fc4c620b67b19709573a08d22684fb4b65b6ea..e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 100644",
      "--- a/docs/nonew.md",
      "+++ b/docs/nonew.md",
      "@@ -1 +0,0 @@",
      "-hello",
      "\\ No newline at end of file",
    ].join("\n");

    expect(reconstructMarkdownDocument(createdEmpty)).toEqual({ status: "empty" });
    expect(reconstructMarkdownDocument(becameEmpty)).toEqual({ status: "empty" });
  });

  it("reports a deleted file instead of turning removed lines into a document", () => {
    const patch = [
      "diff --git a/docs/guide.md b/docs/guide.md",
      "deleted file mode 100644",
      "index eabd299d71c73460e78ca82f533bb848bc5ca834..0000000000000000000000000000000000000000",
      "--- a/docs/guide.md",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-# Title",
      "-body",
      "",
    ].join("\n");

    expect(reconstructMarkdownDocument(patch)).toEqual({ status: "deleted" });
  });

  it("refuses partial, binary, metadata-only, and multi-file patches", () => {
    const partial = [
      "--- a/docs/guide.md",
      "+++ b/docs/guide.md",
      "@@ -40,1 +40,1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");
    const gapped = [
      "--- a/docs/guide.md",
      "+++ b/docs/guide.md",
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new",
      "@@ -20,1 +30,1 @@",
      "-later",
      "+later still",
      "",
    ].join("\n");
    const binary = [
      "diff --git a/bin.md b/bin.md",
      "new file mode 100644",
      "index 0000000000000000000000000000000000000000..20b5be91886d0b6f26dc98a225c0dac05fe2c86e",
      "Binary files /dev/null and b/bin.md differ",
      "",
    ].join("\n");
    const metadata = [
      "diff --git a/docs/guide.md b/docs/guide.md",
      "old mode 100644",
      "new mode 100755",
      "",
    ].join("\n");
    const combined = [
      "diff --git a/a.md b/a.md",
      "--- a/a.md",
      "+++ b/a.md",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "diff --git a/b.md b/b.md",
      "--- a/b.md",
      "+++ b/b.md",
      "@@ -1 +1 @@",
      "-c",
      "+d",
      "",
    ].join("\n");

    expect(reconstructMarkdownDocument(partial).status).toBe("unavailable");
    expect(reconstructMarkdownDocument(gapped).status).toBe("unavailable");
    expect(reconstructMarkdownDocument(binary).status).toBe("unavailable");
    expect(reconstructMarkdownDocument(metadata).status).toBe("unavailable");
    expect(reconstructMarkdownDocument(combined).status).toBe("unavailable");
    expect(reconstructMarkdownDocument("").status).toBe("unavailable");
  });

  it("reads a path that contains spaces when git terminates the header with a tab", () => {
    const patch = [
      "diff --git a/docs/my file.md b/docs/my file.md",
      "index ce013625030ba8dba906f756967f9e9ca394464a..94954abda49de8615a048f8d2e64b5de848e27a1 100644",
      "--- a/docs/my file.md\t",
      "+++ b/docs/my file.md\t",
      "@@ -1 +1,2 @@",
      " hello",
      "+world",
      "",
    ].join("\n");

    expect(reconstructMarkdownDocument(patch)).toEqual({
      status: "document",
      content: "hello\nworld\n",
    });
  });
});

describe("trailingContextHidesDocumentEnd", () => {
  it("flags only a saturated unified-context window", () => {
    expect(trailingContextHidesDocumentEnd(DIFF_UNIFIED_CONTEXT_LINES - 1)).toBe(false);
    expect(trailingContextHidesDocumentEnd(DIFF_UNIFIED_CONTEXT_LINES)).toBe(true);
  });
});
