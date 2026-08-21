import { describe, expect, it } from "vitest";
import { formatCompletionComment, formatToolAction } from "./callbacks";

// ─── formatToolAction ────────────────────────────────────────────────────────

describe("formatToolAction", () => {
  it("edit_file with filepath", () => {
    expect(formatToolAction("edit_file", { filepath: "src/main.ts" })).toEqual({
      action: "Edit",
      parameter: "src/main.ts",
    });
  });

  it("write_file with path", () => {
    expect(formatToolAction("write_file", { path: "out/bundle.js" })).toEqual({
      action: "Edit",
      parameter: "out/bundle.js",
    });
  });

  it("edit_file falls back to 'file' when no filepath or path", () => {
    expect(formatToolAction("edit_file", {})).toEqual({ action: "Edit", parameter: "file" });
  });

  it("read_file with filepath", () => {
    expect(formatToolAction("read_file", { filepath: "README.md" })).toEqual({
      action: "Read",
      parameter: "README.md",
    });
  });

  it("read_file with path", () => {
    expect(formatToolAction("read_file", { path: "docs/guide.md" })).toEqual({
      action: "Read",
      parameter: "docs/guide.md",
    });
  });

  it("read_file falls back to 'file' when no filepath or path", () => {
    expect(formatToolAction("read_file", {})).toEqual({ action: "Read", parameter: "file" });
  });

  it("bash with command", () => {
    expect(formatToolAction("bash", { command: "npm test" })).toEqual({
      action: "Run",
      parameter: "npm test",
    });
  });

  it("execute_command with cmd", () => {
    expect(formatToolAction("execute_command", { cmd: "ls -la" })).toEqual({
      action: "Run",
      parameter: "ls -la",
    });
  });

  it("bash with command >80 chars truncates to 77 + ...", () => {
    const longCmd = "a".repeat(100);
    expect(formatToolAction("bash", { command: longCmd })).toEqual({
      action: "Run",
      parameter: `${"a".repeat(77)}...`,
    });
  });

  it("bash with command exactly 80 chars is not truncated", () => {
    const cmd = "a".repeat(80);
    expect(formatToolAction("bash", { command: cmd })).toEqual({
      action: "Run",
      parameter: cmd,
    });
  });

  it("bash with no command falls back to a placeholder so parameter is never empty", () => {
    // Linear's API rejects action activities with empty `parameter` fields.
    expect(formatToolAction("bash", {})).toEqual({ action: "Run", parameter: "(no command)" });
  });

  it("unknown tool uses the tool name as action and a string arg as parameter", () => {
    expect(formatToolAction("search_files", { query: "foo" })).toEqual({
      action: "search_files",
      parameter: "foo",
    });
  });

  it("unknown tool with no string args falls back to a placeholder parameter", () => {
    expect(formatToolAction("noop", { count: 3 })).toEqual({
      action: "noop",
      parameter: "(no args)",
    });
  });

  it("unknown tool truncates very long string args to 200 chars", () => {
    const long = "x".repeat(500);
    const result = formatToolAction("fetch_url", { url: long });
    expect(result.action).toBe("fetch_url");
    expect(result.parameter).toHaveLength(200);
    expect(result.parameter).toBe("x".repeat(200));
  });
});

// ─── formatCompletionComment ─────────────────────────────────────────────────

describe("formatCompletionComment", () => {
  it("uses the configured app name on success", () => {
    expect(formatCompletionComment("Acme Bot", true, "All set.")).toBe(
      "## 🤖 Acme Bot completed\n\nAll set."
    );
  });

  it("uses the configured app name on failure", () => {
    expect(formatCompletionComment("Acme Bot", false, "Something went wrong.")).toBe(
      "## ⚠️ Acme Bot encountered an issue\n\nSomething went wrong."
    );
  });

  it("works with the default Open-Inspect name", () => {
    expect(formatCompletionComment("Open-Inspect", true, "ok")).toBe(
      "## 🤖 Open-Inspect completed\n\nok"
    );
  });
});
