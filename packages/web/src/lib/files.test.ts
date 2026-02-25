import { describe, it, expect } from "vitest";
import { extractChangedFiles } from "./files";

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
          oldString: "import a from 'a';\nimport b from 'b';\nconst x = 1;\nconst y = 2;\nconst z = 3;",
          newString: "import a from 'a';\nimport b from 'b';\nconst x = 42;\nconst y = 2;\nconst z = 3;",
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
});
