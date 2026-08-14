import { describe, expect, it } from "vitest";
import { getScmRepoSettingsPath } from "./scm-settings-path";

describe("getScmRepoSettingsPath", () => {
  it("encodes a nested GitLab namespace as one owner segment", () => {
    expect(getScmRepoSettingsPath("group/subgroup/repo")).toBe(
      "/api/scm-settings/repos/group%2Fsubgroup/repo"
    );
  });

  it("rejects malformed repository names", () => {
    expect(getScmRepoSettingsPath("repo")).toBeNull();
  });
});
