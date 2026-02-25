import { describe, it, expect } from "vitest";
import { extractChangedFiles, parseApplyPatch } from "./files";

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: "tool_call" as string,
    tool: "Edit" as string | undefined,
    args: { filePath: "src/index.ts", oldString: "a\nb", newString: "a\nb\nc" } as
      | Record<string, unknown>
      | undefined,
    status: "completed" as string | undefined,
    timestamp: 1000,
    ...overrides,
  };
}

describe("extractChangedFiles", () => {
  it("returns empty array for empty events", () => {
    expect(extractChangedFiles([])).toEqual([]);
  });

  it("ignores non-tool_call events", () => {
    const events = [makeEvent({ type: "token" })];
    expect(extractChangedFiles(events)).toEqual([]);
  });

  it("ignores non-Edit/Write tools", () => {
    const events = [makeEvent({ tool: "Read" }), makeEvent({ tool: "Bash" })];
    expect(extractChangedFiles(events)).toEqual([]);
  });

  it("ignores events without status completed", () => {
    const events = [
      makeEvent({ status: "pending" }),
      makeEvent({ status: "running" }),
      makeEvent({ status: "error" }),
      makeEvent({ status: undefined }),
    ];
    expect(extractChangedFiles(events)).toEqual([]);
  });

  it("extracts a single Edit event with accurate diff stats", () => {
    // oldString: "a\nb" (2 lines), newString: "a\nb\nc" (3 lines)
    // Only line "c" was actually added — diffLines correctly reports +1/-0
    const events = [makeEvent()];
    expect(extractChangedFiles(events)).toEqual([
      { filename: "src/index.ts", additions: 1, deletions: 0 },
    ]);
  });

  it("extracts a single Write event", () => {
    const events = [
      makeEvent({
        tool: "Write",
        args: { filePath: "src/new.ts", content: "line1\nline2\nline3" },
      }),
    ];
    expect(extractChangedFiles(events)).toEqual([
      { filename: "src/new.ts", additions: 3, deletions: 0 },
    ]);
  });

  it("uses file_path fallback when filePath is missing", () => {
    const events = [
      makeEvent({
        args: { file_path: "src/fallback.ts", oldString: "a", newString: "b" },
      }),
    ];
    expect(extractChangedFiles(events)).toEqual([
      { filename: "src/fallback.ts", additions: 1, deletions: 1 },
    ]);
  });

  it("skips events with missing filePath", () => {
    const events = [makeEvent({ args: { oldString: "a", newString: "b" } })];
    expect(extractChangedFiles(events)).toEqual([]);
  });

  it("skips events with empty filePath", () => {
    const events = [makeEvent({ args: { filePath: "", oldString: "a", newString: "b" } })];
    expect(extractChangedFiles(events)).toEqual([]);
  });

  it("deduplicates by file path and accumulates stats", () => {
    const events = [
      makeEvent({
        // "a" → "b\nc": full replacement, 2 added + 1 deleted
        args: { filePath: "src/index.ts", oldString: "a", newString: "b\nc" },
      }),
      makeEvent({
        // "x\ny" → "z": full replacement, 1 added + 2 deleted
        args: { filePath: "src/index.ts", oldString: "x\ny", newString: "z" },
      }),
    ];
    const result = extractChangedFiles(events);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      filename: "src/index.ts",
      additions: 3,
      deletions: 3,
    });
  });

  it("sorts output alphabetically by filename", () => {
    const events = [
      makeEvent({
        args: { filePath: "src/z.ts", oldString: "a", newString: "b" },
      }),
      makeEvent({
        args: { filePath: "src/a.ts", oldString: "a", newString: "b" },
      }),
      makeEvent({
        args: { filePath: "src/m.ts", oldString: "a", newString: "b" },
      }),
    ];
    const result = extractChangedFiles(events);
    expect(result.map((f) => f.filename)).toEqual(["src/a.ts", "src/m.ts", "src/z.ts"]);
  });

  it("handles case-insensitive tool names", () => {
    const events = [
      makeEvent({ tool: "edit" }),
      makeEvent({
        tool: "WRITE",
        args: { filePath: "src/other.ts", content: "x" },
      }),
    ];
    const result = extractChangedFiles(events);
    expect(result).toHaveLength(2);
  });

  it("computes accurate diff for edits with shared context lines", () => {
    // A large edit where only 1 line changed out of many — diffLines correctly
    // reports +1/-1 instead of the old heuristic which would report +5/-5
    const events = [
      makeEvent({
        args: {
          filePath: "src/app.ts",
          oldString:
            "import a from 'a';\nimport b from 'b';\nconst x = 1;\nconst y = 2;\nconst z = 3;",
          newString:
            "import a from 'a';\nimport b from 'b';\nconst x = 42;\nconst y = 2;\nconst z = 3;",
        },
      }),
    ];
    expect(extractChangedFiles(events)).toEqual([
      { filename: "src/app.ts", additions: 1, deletions: 1 },
    ]);
  });

  it("handles missing args gracefully", () => {
    const events = [makeEvent({ args: undefined })];
    expect(extractChangedFiles(events)).toEqual([]);
  });

  it("handles Edit with missing oldString/newString", () => {
    const events = [
      makeEvent({
        args: { filePath: "src/index.ts" },
      }),
    ];
    expect(extractChangedFiles(events)).toEqual([
      { filename: "src/index.ts", additions: 0, deletions: 0 },
    ]);
  });

  it("handles Write with missing content", () => {
    const events = [
      makeEvent({
        tool: "Write",
        args: { filePath: "src/new.ts" },
      }),
    ];
    expect(extractChangedFiles(events)).toEqual([
      { filename: "src/new.ts", additions: 0, deletions: 0 },
    ]);
  });

  // --- apply_patch tests ---

  it("extracts a single-file add patch with correct addition count", () => {
    const events = [
      makeEvent({
        tool: "apply_patch",
        args: {
          patchText: [
            "*** Begin Patch",
            "*** Add File: src/new-file.ts",
            "+import { foo } from 'bar';",
            "+",
            "+export function hello() {",
            "+  return 'world';",
            "+}",
            "*** End Patch",
          ].join("\n"),
        },
      }),
    ];
    expect(extractChangedFiles(events)).toEqual([
      { filename: "src/new-file.ts", additions: 5, deletions: 0 },
    ]);
  });

  it("extracts a single-file update patch with correct additions and deletions", () => {
    const events = [
      makeEvent({
        tool: "apply_patch",
        args: {
          patchText: [
            "*** Begin Patch",
            "*** Update File: src/index.ts",
            "@@ -1,4 +1,5 @@",
            " import { foo } from 'bar';",
            "-const x = 1;",
            "-const y = 2;",
            "+const x = 10;",
            "+const y = 20;",
            "+const z = 30;",
            " export default x;",
            "*** End Patch",
          ].join("\n"),
        },
      }),
    ];
    // 3 additions (+), 2 deletions (-)
    expect(extractChangedFiles(events)).toEqual([
      { filename: "src/index.ts", additions: 3, deletions: 2 },
    ]);
  });

  it("extracts a single-file delete patch", () => {
    const events = [
      makeEvent({
        tool: "apply_patch",
        args: {
          patchText: ["*** Begin Patch", "*** Delete File: src/obsolete.ts", "*** End Patch"].join(
            "\n"
          ),
        },
      }),
    ];
    // File shows up with 0/0 stats (no body lines to count)
    expect(extractChangedFiles(events)).toEqual([
      { filename: "src/obsolete.ts", additions: 0, deletions: 0 },
    ]);
  });

  it("extracts multi-file patch with correct per-file stats", () => {
    const events = [
      makeEvent({
        tool: "apply_patch",
        args: {
          patchText: [
            "*** Begin Patch",
            "*** Add File: src/a.ts",
            "+line1",
            "+line2",
            "*** Update File: src/b.ts",
            "@@ -1,2 +1,2 @@",
            "-old",
            "+new",
            " unchanged",
            "*** Delete File: src/c.ts",
            "*** End Patch",
          ].join("\n"),
        },
      }),
    ];
    expect(extractChangedFiles(events)).toEqual([
      { filename: "src/a.ts", additions: 2, deletions: 0 },
      { filename: "src/b.ts", additions: 1, deletions: 1 },
      { filename: "src/c.ts", additions: 0, deletions: 0 },
    ]);
  });

  it("accumulates apply_patch + Edit stats on same file", () => {
    const events = [
      makeEvent({
        tool: "apply_patch",
        args: {
          patchText: [
            "*** Begin Patch",
            "*** Update File: src/index.ts",
            "@@ -1,2 +1,2 @@",
            "-old line",
            "+new line",
            "*** End Patch",
          ].join("\n"),
        },
      }),
      // Subsequent Edit on the same file
      makeEvent({
        tool: "Edit",
        args: { filePath: "src/index.ts", oldString: "a", newString: "b\nc" },
      }),
    ];
    // apply_patch: +1/-1, Edit: +2/-1 (diffLines: "a" → "b\nc")
    expect(extractChangedFiles(events)).toEqual([
      { filename: "src/index.ts", additions: 3, deletions: 2 },
    ]);
  });

  it("skips apply_patch with empty patchText", () => {
    const events = [makeEvent({ tool: "apply_patch", args: { patchText: "" } })];
    expect(extractChangedFiles(events)).toEqual([]);
  });

  it("skips apply_patch with undefined patchText", () => {
    const events = [makeEvent({ tool: "apply_patch", args: { patchText: undefined } })];
    expect(extractChangedFiles(events)).toEqual([]);
  });

  it("skips apply_patch with missing args", () => {
    const events = [makeEvent({ tool: "apply_patch", args: undefined })];
    expect(extractChangedFiles(events)).toEqual([]);
  });

  it("handles update patch with multiple hunks", () => {
    const events = [
      makeEvent({
        tool: "apply_patch",
        args: {
          patchText: [
            "*** Begin Patch",
            "*** Update File: src/app.ts",
            "@@ -1,3 +1,3 @@",
            " import a;",
            "-const x = 1;",
            "+const x = 2;",
            " const y = 3;",
            "@@ -10,3 +10,4 @@",
            " function foo() {",
            "+  console.log('added');",
            "   return true;",
            " }",
            "*** End Patch",
          ].join("\n"),
        },
      }),
    ];
    // Hunk 1: +1/-1; Hunk 2: +1/-0 → total: +2/-1
    expect(extractChangedFiles(events)).toEqual([
      { filename: "src/app.ts", additions: 2, deletions: 1 },
    ]);
  });

  it("skips *** End of File markers in patch body", () => {
    const events = [
      makeEvent({
        tool: "apply_patch",
        args: {
          patchText: [
            "*** Begin Patch",
            "*** Add File: src/new.ts",
            "+content",
            "*** End of File",
            "*** End Patch",
          ].join("\n"),
        },
      }),
    ];
    expect(extractChangedFiles(events)).toEqual([
      { filename: "src/new.ts", additions: 1, deletions: 0 },
    ]);
  });
});

describe("parseApplyPatch", () => {
  it("returns empty array for patch with no file sections", () => {
    expect(parseApplyPatch("*** Begin Patch\n*** End Patch")).toEqual([]);
  });

  it("correctly counts context lines as neither additions nor deletions", () => {
    const result = parseApplyPatch(
      [
        "*** Update File: src/foo.ts",
        "@@ -1,5 +1,5 @@",
        " line1",
        " line2",
        "-old",
        "+new",
        " line4",
      ].join("\n")
    );
    expect(result).toEqual([{ filePath: "src/foo.ts", additions: 1, deletions: 1 }]);
  });

  it("handles file path with spaces", () => {
    const result = parseApplyPatch(["*** Add File: src/my file.ts", "+content"].join("\n"));
    expect(result).toEqual([{ filePath: "src/my file.ts", additions: 1, deletions: 0 }]);
  });
});
