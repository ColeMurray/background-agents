import { describe, expect, it } from "vitest";
import { isMarkdownPath, previewMarkdownDocument } from "./markdown-preview";

function patch(headers: string[], hunk: string[]): string {
  return [...headers, ...hunk, ""].join("\n");
}

const MODIFIED = ["diff --git a/README.md b/README.md", "index 1111111..2222222 100644"];
const MODIFIED_PATHS = [...MODIFIED, "--- a/README.md", "+++ b/README.md"];

describe("isMarkdownPath", () => {
  it.each(["README.md", "docs/Guide.MD", "notes.markdown", "a/b/c.Markdown"])(
    "accepts %s",
    (path) => expect(isMarkdownPath(path)).toBe(true)
  );

  it.each([".md", "docs/.md", "README", "notes.mdx", "README.md.txt", "md"])("rejects %s", (path) =>
    expect(isMarkdownPath(path)).toBe(false)
  );
});

describe("previewMarkdownDocument", () => {
  it("rebuilds the whole resulting document, including unchanged lines", () => {
    const result = previewMarkdownDocument(
      patch(MODIFIED_PATHS, ["@@ -1,4 +1,4 @@", " # Title", " before", "-old", "+new", " after"])
    );

    expect(result).toEqual({ status: "document", content: "# Title\nbefore\nnew\nafter\n" });
  });

  it("keeps a missing trailing newline and CRLF line endings", () => {
    expect(
      previewMarkdownDocument(
        patch(MODIFIED_PATHS, [
          "@@ -1,2 +1,2 @@",
          " # Title\r",
          "-old",
          "+new",
          "\\ No newline at end of file",
        ])
      )
    ).toEqual({ status: "document", content: "# Title\r\nnew" });
  });

  it("previews added and renamed files", () => {
    expect(
      previewMarkdownDocument(
        patch(
          [
            "diff --git a/NEW.md b/NEW.md",
            "new file mode 100644",
            "index 0000000..1111111",
            "--- /dev/null",
            "+++ b/NEW.md",
          ],
          ["@@ -0,0 +1,2 @@", "+# New", "+body"]
        )
      )
    ).toEqual({ status: "document", content: "# New\nbody\n" });

    expect(
      previewMarkdownDocument(
        patch(
          [
            "diff --git a/old.md b/new.md",
            "similarity index 80%",
            "rename from old.md",
            "rename to new.md",
            "index 1111111..2222222 100644",
            "--- a/old.md",
            "+++ b/new.md",
          ],
          ["@@ -1,2 +1,2 @@", " # Moved", "-a", "+b"]
        )
      )
    ).toEqual({ status: "document", content: "# Moved\nb\n" });
  });

  it("reports deleted and empty documents", () => {
    expect(
      previewMarkdownDocument(
        patch(
          [
            "diff --git a/README.md b/README.md",
            "deleted file mode 100644",
            "index 1111111..0000000",
            "--- a/README.md",
            "+++ /dev/null",
          ],
          ["@@ -1 +0,0 @@", "-# Gone"]
        )
      )
    ).toEqual({ status: "deleted" });

    expect(
      previewMarkdownDocument(
        patch(
          ["diff --git a/EMPTY.md b/EMPTY.md", "new file mode 100644", "index 0000000..e69de29"],
          []
        )
      )
    ).toEqual({ status: "empty" });

    expect(previewMarkdownDocument(patch(MODIFIED_PATHS, ["@@ -1 +0,0 @@", "-# Cleared"]))).toEqual(
      { status: "empty" }
    );
  });

  it("refuses patches that do not hold one complete document", () => {
    const partial = patch(MODIFIED_PATHS, ["@@ -40,3 +40,3 @@", " a", "-b", "+c", " d"]);
    const truncated = patch(MODIFIED_PATHS, ["@@ -1,3 +1,3 @@", " # Title", "-old", "+new"]);
    const twoHunks = patch(MODIFIED_PATHS, [
      "@@ -1,1 +1,1 @@",
      "-a",
      "+b",
      "@@ -9,1 +9,1 @@",
      "-c",
      "+d",
    ]);
    const binary = patch(MODIFIED, ["Binary files a/README.md and b/README.md differ"]);
    const twoFiles =
      patch(MODIFIED_PATHS, ["@@ -1 +1 @@", "-a", "+b"]) +
      patch(
        ["diff --git a/b.md b/b.md", "index 1111111..2222222 100644", "--- a/b.md", "+++ b/b.md"],
        ["@@ -1 +1 @@", "-a", "+b"]
      );

    for (const input of ["", partial, truncated, twoHunks, binary, twoFiles]) {
      expect(previewMarkdownDocument(input)).toEqual({ status: "unavailable" });
    }
  });
});
