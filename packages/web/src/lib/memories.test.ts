import { describe, expect, it } from "vitest";
import { memorySettingsLink } from "./memories";

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
