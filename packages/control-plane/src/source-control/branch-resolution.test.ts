import { describe, expect, it } from "vitest";
import { resolveHeadBranchForPr, sanitizeBranchName } from "./branch-resolution";

describe("sanitizeBranchName", () => {
  it("accepts standard git branch names", () => {
    expect(sanitizeBranchName("feature/test")).toBe("feature/test");
  });

  it("rejects invalid or unsafe branch names", () => {
    expect(sanitizeBranchName("")).toBeNull();
    expect(sanitizeBranchName("HEAD")).toBeNull();
    expect(sanitizeBranchName("feature with spaces")).toBeNull();
    expect(sanitizeBranchName("feature..one")).toBeNull();
  });
});

describe("resolveHeadBranchForPr", () => {
  it("prefers request branch when valid", () => {
    const result = resolveHeadBranchForPr({
      requestedHeadBranch: "feature/requested",
      sessionBranchName: "feature/session",
      generatedBranchName: "open-inspect/session-1",
      baseBranch: "main",
    });

    expect(result.headBranch).toBe("feature/requested");
    expect(result.source).toBe("request");
  });

  it("falls back to session branch when requested branch is invalid", () => {
    const result = resolveHeadBranchForPr({
      requestedHeadBranch: "feature invalid",
      sessionBranchName: "feature/session",
      generatedBranchName: "open-inspect/session-1",
      baseBranch: "main",
    });

    expect(result.headBranch).toBe("feature/session");
    expect(result.source).toBe("session");
  });

  it("skips branches that match base and falls back to generated branch", () => {
    const result = resolveHeadBranchForPr({
      requestedHeadBranch: "main",
      sessionBranchName: " main ",
      generatedBranchName: "open-inspect/session-1",
      baseBranch: "main",
    });

    expect(result.headBranch).toBe("open-inspect/session-1");
    expect(result.source).toBe("generated");
  });
});
