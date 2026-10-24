import { describe, expect, it } from "vitest";
import { memorySettingsLink } from "./memories";

describe("memorySettingsLink", () => {
  it.each([
    [{ type: "personal" } as const, "/settings?scope=personal&tab=memories&memoryId=mem_a"],
    [
      { type: "repository", repoOwner: "group/sub", repoName: "web" } as const,
      "/settings?scope=shared&tab=shared-memories&memoryId=mem_a",
    ],
    [
      { type: "environment", environmentId: "env_1" } as const,
      "/settings?scope=environment&environmentId=env_1&tab=shared-memories&memoryId=mem_a",
    ],
  ])("links %j to its management tab", (scope, expected) => {
    expect(memorySettingsLink(scope, "mem_a")).toBe(expected);
  });

  it("ignores historical or reused repository names and encodes the record ID", () => {
    const oldScope = { type: "repository" as const, repoOwner: "old/group", repoName: "reused" };
    expect(memorySettingsLink(oldScope, "mem/a?b")).toBe(
      "/settings?scope=shared&tab=shared-memories&memoryId=mem%2Fa%3Fb"
    );
  });
});
