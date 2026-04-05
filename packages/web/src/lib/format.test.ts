import { describe, expect, it } from "vitest";

import {
  formatModelName,
  formatModelNameLower,
  truncateBranch,
  formatFilePath,
  formatDiffStat,
} from "./format";

describe("formatModelName", () => {
  it("returns 'Unknown Model' for empty string", () => {
    expect(formatModelName("")).toBe("Unknown Model");
  });

  it("formats a known anthropic model id", () => {
    expect(formatModelName("anthropic/claude-sonnet-4-5")).toBe("Claude Sonnet 4.5");
  });

  it("formats a known openai model id", () => {
    expect(formatModelName("openai/gpt-5.2")).toBe("GPT 5.2");
  });

  it("formats a known opencode model id", () => {
    expect(formatModelName("opencode/kimi-k2.5")).toBe("Kimi K2.5");
  });

  it("normalizes short claude model id without provider prefix", () => {
    // normalizeModelId prepends 'anthropic/' for 'claude-*' ids
    expect(formatModelName("claude-sonnet-4-5")).toBe("Claude Sonnet 4.5");
  });

  it("returns the raw modelId for unknown models", () => {
    expect(formatModelName("some/unknown-model")).toBe("some/unknown-model");
  });
});

describe("formatModelNameLower", () => {
  it("returns 'unknown model' for empty string", () => {
    expect(formatModelNameLower("")).toBe("unknown model");
  });

  it("formats a known model id in lowercase", () => {
    expect(formatModelNameLower("anthropic/claude-sonnet-4-5")).toBe("claude sonnet 4.5");
  });

  it("returns raw modelId in lowercase for unknown models", () => {
    expect(formatModelNameLower("some/Unknown-Model")).toBe("some/unknown-model");
  });
});

describe("truncateBranch", () => {
  it("returns empty string for falsy input", () => {
    expect(truncateBranch("")).toBe("");
  });

  it("returns the branch name as-is when at or below maxLength", () => {
    expect(truncateBranch("main", 30)).toBe("main");
    expect(truncateBranch("a".repeat(30), 30)).toBe("a".repeat(30));
  });

  it("truncates with ellipsis prefix when over maxLength", () => {
    const long = "feature/very-long-branch-name-here-indeed";
    const result = truncateBranch(long, 30);
    expect(result.startsWith("...")).toBe(true);
    expect(result.length).toBe(33); // "..." + 30 chars
  });

  it("uses default maxLength of 30", () => {
    const long = "a".repeat(31);
    const result = truncateBranch(long);
    expect(result).toBe("..." + "a".repeat(30));
  });
});

describe("formatFilePath", () => {
  it("returns empty display and full for falsy input", () => {
    expect(formatFilePath("")).toEqual({ display: "", full: "" });
  });

  it("returns basename when at or below maxLength", () => {
    expect(formatFilePath("src/index.ts", 40)).toEqual({
      display: "index.ts",
      full: "src/index.ts",
    });
  });

  it("truncates basename when over maxLength", () => {
    const longFile = "a".repeat(50) + ".ts";
    const result = formatFilePath(`src/${longFile}`, 40);
    expect(result.display.endsWith("...")).toBe(true);
    expect(result.display.length).toBe(40);
    expect(result.full).toBe(`src/${longFile}`);
  });

  it("uses default maxLength of 40", () => {
    const longBase = "b".repeat(50) + ".ts";
    const result = formatFilePath(`dir/${longBase}`);
    expect(result.display).toBe("b".repeat(37) + "...");
    expect(result.full).toBe(`dir/${longBase}`);
  });

  it("handles filenames without directory separators", () => {
    expect(formatFilePath("README.md")).toEqual({
      display: "README.md",
      full: "README.md",
    });
  });
});

describe("formatDiffStat", () => {
  it("formats positive additions and deletions with prefix", () => {
    expect(formatDiffStat(5, 3)).toEqual({ additions: "+5", deletions: "-3" });
  });

  it("formats zero additions as +0 and zero deletions as -0", () => {
    expect(formatDiffStat(0, 0)).toEqual({ additions: "+0", deletions: "-0" });
  });

  it("formats large numbers correctly", () => {
    expect(formatDiffStat(100, 50)).toEqual({ additions: "+100", deletions: "-50" });
  });

  it("formats additions of 1 and deletions of 1", () => {
    expect(formatDiffStat(1, 1)).toEqual({ additions: "+1", deletions: "-1" });
  });
});
