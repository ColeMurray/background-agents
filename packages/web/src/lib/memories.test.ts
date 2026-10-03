import { describe, expect, it } from "vitest";
import { includePersonalMemoriesInput, memoryPreviewInput, memorySettingsLink } from "./memories";

describe("memorySettingsLink", () => {
  it.each([
    [{ type: "personal" } as const, "/settings?scope=personal&tab=memories&memoryId=mem_a"],
    [
      { type: "repository", repoOwner: "group/sub", repoName: "web" } as const,
      "/settings?scope=repository&repoOwner=group%2Fsub&repoName=web&tab=shared-memories&memoryId=mem_a",
    ],
    [
      { type: "environment", environmentId: "env_1" } as const,
      "/settings?scope=environment&environmentId=env_1&tab=shared-memories&memoryId=mem_a",
    ],
  ])("links %j to its management tab", (scope, expected) => {
    expect(memorySettingsLink(scope, "mem_a")).toBe(expected);
  });
});

describe("personal memory choice", () => {
  it.each([
    ["default", undefined],
    ["include", true],
    ["exclude", false],
  ] as const)("sends %s as %s", (choice, expected) => {
    expect(includePersonalMemoriesInput(choice)).toBe(expected);
  });
});

describe("memoryPreviewInput", () => {
  it("previews nothing until the target is known", () => {
    expect(memoryPreviewInput(null, "default")).toBeNull();
  });

  it("previews personal memories only for a repository-less session", () => {
    expect(memoryPreviewInput({ repoOwner: null, repoName: null }, "exclude")).toEqual({
      includePersonalMemories: false,
    });
  });

  it("maps each target form onto the preview contract", () => {
    expect(
      memoryPreviewInput({ repoOwner: "acme", repoName: "web", branch: "dev" }, "include")
    ).toEqual({
      repositories: [{ repoOwner: "acme", repoName: "web", baseBranch: "dev" }],
      includePersonalMemories: true,
    });
    expect(memoryPreviewInput({ repoOwner: "acme", repoName: "web" }, "exclude")).toEqual({
      repositories: [{ repoOwner: "acme", repoName: "web" }],
      includePersonalMemories: false,
    });
    expect(
      memoryPreviewInput({ repositories: [{ repoOwner: "acme", repoName: "api" }] }, "default")
    ).toEqual({
      repositories: [{ repoOwner: "acme", repoName: "api" }],
      includePersonalMemories: undefined,
    });
    expect(memoryPreviewInput({ environmentId: "env_1" }, "default")).toEqual({
      environmentId: "env_1",
      includePersonalMemories: undefined,
    });
  });
});
