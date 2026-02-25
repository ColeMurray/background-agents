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

  it("extracts a single Edit event", () => {
    const events = [makeEvent()];
    expect(extractChangedFiles(events)).toEqual([
      { filename: "src/index.ts", additions: 3, deletions: 2 },
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
        args: { filePath: "src/index.ts", oldString: "a", newString: "b\nc" },
      }),
      makeEvent({
        args: { filePath: "src/index.ts", oldString: "x\ny", newString: "z" },
      }),
    ];
    const result = extractChangedFiles(events);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      filename: "src/index.ts",
      additions: 2 + 1, // 2 lines + 1 line
      deletions: 1 + 2, // 1 line + 2 lines
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
