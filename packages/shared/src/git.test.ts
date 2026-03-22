import { describe, expect, it } from "vitest";
import {
  extractSessionIdFromBranch,
  generateBranchName,
  isInspectBranch,
  normalizeBranchName,
} from "./git";

describe("normalizeBranchName", () => {
  it("trims and lowercases branch names", () => {
    expect(normalizeBranchName(" Feature/Test ")).toBe("feature/test");
  });
});

describe("generateBranchName", () => {
  it("generates lowercase open-inspect branches", () => {
    expect(generateBranchName("Session-ABC")).toBe("open-inspect/session-abc");
  });
});

describe("extractSessionIdFromBranch", () => {
  it("extracts lowercase session IDs from inspect branches", () => {
    expect(extractSessionIdFromBranch(" Open-Inspect/Session-ABC ")).toBe("session-abc");
  });
});

describe("isInspectBranch", () => {
  it("matches inspect branches case-insensitively", () => {
    expect(isInspectBranch(" OPEN-INSPECT/Session-ABC ")).toBe(true);
  });
});
