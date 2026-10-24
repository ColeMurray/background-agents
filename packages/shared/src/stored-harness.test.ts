import { describe, expect, it } from "vitest";
import { getStoredHarnessOrRefuse, getValidHarnessOrDefault, HARNESS_IDS } from "./harnesses";

describe("a stored harness", () => {
  it("resolves a harness this binary knows", () => {
    expect(getStoredHarnessOrRefuse("opencode")).toBe("opencode");
    expect(getStoredHarnessOrRefuse("claude")).toBe("claude");
    expect(getStoredHarnessOrRefuse("codex")).toBe("codex");
    expect(getStoredHarnessOrRefuse("pi")).toBe("pi");
  });

  it("refuses a harness this binary does not know, rather than falling back", () => {
    // The row was written by a newer binary, or the deployment was rolled
    // back. The session cannot be run as a different harness.
    expect(getStoredHarnessOrRefuse("some-future-harness")).toBeNull();
  });

  it("treats an absent stored harness as the built-in one", () => {
    expect(getStoredHarnessOrRefuse(null)).toBe("opencode");
    expect(getStoredHarnessOrRefuse(undefined)).toBe("opencode");
    expect(getStoredHarnessOrRefuse("")).toBe("opencode");
  });

  it("still falls back for a requested harness, which is a typo and not a row", () => {
    // A request may fall back: an unknown value in a create body is a typo,
    // and the caller asked for something.
    expect(getValidHarnessOrDefault("some-future-harness")).toBe("opencode");
  });

  it("knows every harness the catalogue names", () => {
    for (const harness of HARNESS_IDS) {
      expect(getStoredHarnessOrRefuse(harness)).toBe(harness);
    }
  });
});
