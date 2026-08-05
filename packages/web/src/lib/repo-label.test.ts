import { describe, expect, it } from "vitest";
import { formatSessionRepositoriesLabel, NO_REPOSITORY_LABEL } from "./repo-label";

describe("formatSessionRepositoriesLabel", () => {
  it("renders the scalar repo when there is no member list", () => {
    expect(formatSessionRepositoriesLabel("acme", "web")).toBe("acme/web");
  });

  it("renders 'No repository' when the scalar repo is absent and there is no member list", () => {
    expect(formatSessionRepositoriesLabel(null, null)).toBe(NO_REPOSITORY_LABEL);
  });

  it("renders a single-member session exactly as the scalar repo", () => {
    expect(
      formatSessionRepositoriesLabel("acme", "web", [{ repoOwner: "acme", repoName: "web" }])
    ).toBe("acme/web");
  });

  it("shows the primary with a +N suffix for the remaining members", () => {
    expect(
      formatSessionRepositoriesLabel("acme", "web", [
        { repoOwner: "acme", repoName: "web" },
        { repoOwner: "acme", repoName: "api" },
        { repoOwner: "acme", repoName: "cli" },
      ])
    ).toBe("acme/web +2");
  });

  it("prefers the hydrated primary over the scalar when both are present", () => {
    expect(
      formatSessionRepositoriesLabel(null, null, [
        { repoOwner: "acme", repoName: "web" },
        { repoOwner: "acme", repoName: "api" },
      ])
    ).toBe("acme/web +1");
  });
});
