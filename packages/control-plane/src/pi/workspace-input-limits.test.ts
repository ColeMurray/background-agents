import { describe, expect, it } from "vitest";
import {
  WORKSPACE_MAX_EDIT_COUNT,
  WORKSPACE_MAX_PATH_BYTES,
  WORKSPACE_MAX_PATH_SEGMENTS,
  validateWorkspaceToolInput,
} from "./workspace-input-limits";

describe("validateWorkspaceToolInput", () => {
  it("bounds paths by UTF-8 bytes and segment depth before filesystem access", () => {
    expect(() =>
      validateWorkspaceToolInput("read", { path: `/${"😀".repeat(WORKSPACE_MAX_PATH_BYTES)}` })
    ).toThrow(/UTF-8 bytes/);
    expect(() =>
      validateWorkspaceToolInput("read", {
        path: `/${Array.from({ length: WORKSPACE_MAX_PATH_SEGMENTS + 1 }, () => "x").join("/")}`,
      })
    ).toThrow(/segments/);
  });

  it("bounds edit count and structural bytes before Computer prepares arguments", () => {
    expect(() =>
      validateWorkspaceToolInput("edit", {
        path: "/workspace/scratch/a.txt",
        edits: Array.from({ length: WORKSPACE_MAX_EDIT_COUNT + 1 }, () => ({
          oldText: "a",
          newText: "b",
        })),
      })
    ).toThrow(/edit count/);
    expect(() =>
      validateWorkspaceToolInput("edit", {
        path: "/workspace/scratch/a.txt",
        edits: [{ oldText: "a".repeat(2 * 1024 * 1024), newText: "b" }],
      })
    ).toThrow(/structural bytes/);
  });

  it("keeps literal grep useful while rejecting regular expressions and oversized globs", () => {
    const literal = validateWorkspaceToolInput("grep", {
      path: "/workspace/scratch",
      query: "(a+)+$",
    });
    expect(literal).toMatchObject({ query: "(a+)+$" });
    expect("regex" in literal).toBe(false);
    expect(() =>
      validateWorkspaceToolInput("grep", {
        path: "/workspace/scratch",
        query: "(a+)+$",
        regex: true,
      })
    ).toThrow(/regular expressions are disabled/i);
    expect(() =>
      validateWorkspaceToolInput("find", {
        path: "/workspace/scratch",
        pattern: "*".repeat(20_000),
      })
    ).toThrow(/pattern/);
  });
});
