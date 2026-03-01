import { describe, expect, it } from "vitest";
import { normalizeRepoId } from "./repo";

describe("normalizeRepoId", () => {
  it("lowercases owner and name", () => {
    expect(normalizeRepoId("Octocat", "Hello-World")).toBe("octocat/hello-world");
  });

  it("handles already-lowercase input", () => {
    expect(normalizeRepoId("octocat", "repo")).toBe("octocat/repo");
  });

  it("handles all uppercase", () => {
    expect(normalizeRepoId("OWNER", "REPO")).toBe("owner/repo");
  });
});
