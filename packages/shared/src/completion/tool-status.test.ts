import { describe, expect, it } from "vitest";
import { compactPathPart, formatToolStatus, toolCallFilePath } from "./tool-status";
import { summarizeToolCall, toolCallFilePath as legacyFilePath } from "./extractor";

describe("tool status aliases", () => {
  it.each(["file_path", "filePath", "filepath", "path", "file"])(
    "reads the %s file alias",
    (key) => {
      expect(formatToolStatus("Read", { [key]: "/workspace/repo/src/file.ts" })).toBe(
        "Reading src/file.ts"
      );
    }
  );

  it.each([
    ["read", "Reading file"],
    ["READ_FILE", "Reading file"],
    ["Edit", "Editing file"],
    ["eDiT_fIlE", "Editing file"],
    ["write", "Writing file"],
    ["WRITE_FILE", "Writing file"],
    ["Bash", "Running command"],
    ["execute_command", "Running command"],
    ["grep", "Searching for query"],
    ["Search_Files", "Searching for query"],
    ["glob", "Finding files"],
    ["list", "Listing files"],
    ["LIST_FILES", "Listing files"],
    ["list_directory", "Listing files"],
    ["UnknownTool", "Using tool: UnknownTool"],
    ["", "Using tool: unknown"],
  ])("formats %s case-insensitively", (tool, expected) => {
    expect(formatToolStatus(tool)).toBe(expected);
  });

  it.each(["command", "cmd"])(
    "accepts shell argument alias %s without rewriting its URL or path",
    (key) => {
      const command = "curl https://api.example.com/v1/users/me /workspace/repo/a/b/c";
      expect(formatToolStatus("EXECUTE_COMMAND", { [key]: command })).toBe(`Running ${command}`);
    }
  );

  it.each(["pattern", "query"])("accepts search argument alias %s", (key) => {
    expect(formatToolStatus("grep", { [key]: "a/b/c" })).toBe("Searching for a/b/c");
    expect(formatToolStatus("glob", { [key]: "**/*.ts" })).toBe("Finding **/*.ts");
  });

  it("skips empty display aliases and preserves historical file alias precedence", () => {
    expect(formatToolStatus("bash", { command: " \n ", cmd: "npm test" })).toBe("Running npm test");
    expect(toolCallFilePath({ file_path: "first", filePath: "second" })).toBe("first");
    expect(toolCallFilePath({ file_path: 123, filePath: "", path: "valid" })).toBe("valid");
    expect(legacyFilePath).toBe(toolCallFilePath);
  });

  it("lists the requested directory", () => {
    expect(formatToolStatus("list", { path: "/workspace/repo/src" })).toBe("Listing src");
  });
});

describe("file-only compaction and consumer budgets", () => {
  it("normalizes Windows separators and removes only the leading sandbox checkout", () => {
    expect(compactPathPart("\\workspace\\repo\\src\\index.ts")).toBe("src/index.ts");
    expect(compactPathPart("C:\\work\\repo\\src\\index.ts")).toBe("C:/work/repo/src/index.ts");
    expect(compactPathPart("/tmp/workspace/repo/src/index.ts")).toBe(
      "/tmp/workspace/repo/src/index.ts"
    );
  });

  it("retains the most useful trailing path segments within the consumer budget", () => {
    expect(
      formatToolStatus(
        "read",
        {
          filePath:
            "/workspace/background-agents/packages/control-plane/src/session/durable-object.ts",
        },
        { fileStatusMaxLength: 50 }
      )
    ).toBe("Reading src/session/durable-object.ts");
    expect(
      formatToolStatus("read", { path: `src/${"a".repeat(100)}.ts` }, { fileStatusMaxLength: 50 })
    ).toBe(`Reading ${"a".repeat(39)}...`);
    expect(compactPathPart("abcdef", 2)).toBe("..");
    expect(compactPathPart("", 10)).toBe("");
  });

  it("never path-compacts a URL, even when passed as a file argument", () => {
    const url = "https://api.example.com/v1/users/me";
    expect(formatToolStatus("read", { path: url })).toBe(`Reading ${url}`);
    expect(compactPathPart(url, 25)).toBe(`${url.slice(0, 22)}...`);
  });

  it("uses platform normalization before compaction and argument limits", () => {
    expect(
      formatToolStatus(
        "Read",
        { path: "`/workspace/repo/file.ts`" },
        {
          normalizeText: (value) => String(value ?? "").replace(/`/g, ""),
          fileStatusMaxLength: 50,
        }
      )
    ).toBe("Reading file.ts");
    expect(formatToolStatus("Bash", { command: "abcdefghijk" }, { argumentMaxLength: 8 })).toBe(
      "Running abcde..."
    );
  });

  it("normalizes plain display values without platform markup assumptions", () => {
    expect(formatToolStatus(" custom\n<@U123> ")).toBe("Using tool: custom <@U123>");
    expect(formatToolStatus("grep", { pattern: 0 })).toBe("Searching for 0");
    expect(formatToolStatus("grep", { pattern: { query: "x" } })).toBe(
      'Searching for {"query":"x"}'
    );
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(formatToolStatus("grep", { pattern: circular })).toBe("Searching for [object Object]");
  });
});

describe("historical completion summaries", () => {
  it("keeps past-tense text, command clipping, and unknown-tool behavior unchanged", () => {
    expect(
      summarizeToolCall({ tool: "Read", args: { file_path: "/workspace/repo/file.ts" } })
    ).toEqual({ tool: "Read", summary: "Read /workspace/repo/file.ts" });
    expect(summarizeToolCall({ tool: "Bash", args: { command: "a".repeat(40) } }).summary).toBe(
      `Ran: ${"a".repeat(40)}...`
    );
    expect(summarizeToolCall({ tool: "glob", args: { pattern: "**/*.ts" } }).summary).toBe(
      "Used glob"
    );
  });
});
