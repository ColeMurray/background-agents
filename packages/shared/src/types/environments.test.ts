import { describe, expect, it } from "vitest";
import {
  createEnvironmentInputSchema,
  updateEnvironmentInputSchema,
  MAX_ENVIRONMENT_NAME_LENGTH,
} from "./index";

describe("createEnvironmentInputSchema", () => {
  it("parses a valid environment and normalizes member identifiers", () => {
    const parsed = createEnvironmentInputSchema.parse({
      name: "Full Stack",
      description: "web + api",
      prebuildEnabled: true,
      repositories: [
        { repoOwner: "Acme", repoName: "Web", baseBranch: "main" },
        { repoOwner: "acme", repoName: "api" },
      ],
    });
    expect(parsed.repositories).toEqual([
      { repoOwner: "acme", repoName: "web", baseBranch: "main" },
      { repoOwner: "acme", repoName: "api", baseBranch: null },
    ]);
    expect(parsed.prebuildEnabled).toBe(true);
  });

  it("requires a non-empty name", () => {
    expect(
      createEnvironmentInputSchema.safeParse({
        name: "",
        repositories: [{ repoOwner: "a", repoName: "b" }],
      }).success
    ).toBe(false);
  });

  it("rejects a name over the length cap", () => {
    expect(
      createEnvironmentInputSchema.safeParse({
        name: "x".repeat(MAX_ENVIRONMENT_NAME_LENGTH + 1),
        repositories: [{ repoOwner: "a", repoName: "b" }],
      }).success
    ).toBe(false);
  });

  it("rejects an empty member list", () => {
    expect(createEnvironmentInputSchema.safeParse({ name: "X", repositories: [] }).success).toBe(
      false
    );
  });

  it("rejects duplicate owner/name repositories", () => {
    expect(
      createEnvironmentInputSchema.safeParse({
        name: "X",
        repositories: [
          { repoOwner: "acme", repoName: "web" },
          { repoOwner: "acme", repoName: "web" },
        ],
      }).success
    ).toBe(false);
  });

  it("rejects duplicate repoName across owners (checkout path collision)", () => {
    expect(
      createEnvironmentInputSchema.safeParse({
        name: "X",
        repositories: [
          { repoOwner: "acme", repoName: "web" },
          { repoOwner: "other", repoName: "web" },
        ],
      }).success
    ).toBe(false);
  });
});

describe("updateEnvironmentInputSchema", () => {
  it("accepts an empty patch (nothing changes)", () => {
    expect(updateEnvironmentInputSchema.parse({})).toEqual({});
  });

  it("still validates repositories when present", () => {
    expect(updateEnvironmentInputSchema.safeParse({ repositories: [] }).success).toBe(false);
  });

  it("accepts a null description to clear it", () => {
    expect(updateEnvironmentInputSchema.parse({ description: null }).description).toBeNull();
  });
});
