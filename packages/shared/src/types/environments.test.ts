import { describe, expect, it } from "vitest";
import {
  createEnvironmentInputSchema,
  isEnvironmentId,
  updateEnvironmentInputSchema,
  MAX_ENVIRONMENT_NAME_LENGTH,
} from "./index";

describe("isEnvironmentId", () => {
  it("accepts env_-prefixed ids, staying loose on the suffix alphabet", () => {
    expect(isEnvironmentId("env_a1b2c3")).toBe(true);
    expect(isEnvironmentId("env_A1-b2_c3")).toBe(true);
  });

  it("rejects names, owner/name pairs, and bare prefixes", () => {
    expect(isEnvironmentId("full-stack")).toBe(false);
    expect(isEnvironmentId("acme/web")).toBe(false);
    expect(isEnvironmentId("env_")).toBe(false);
    expect(isEnvironmentId("env:env_a1b2")).toBe(false);
  });
});

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
