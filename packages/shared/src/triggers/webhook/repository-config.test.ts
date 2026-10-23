import { describe, expect, it } from "vitest";
import { triggerConfigSchema } from "../types";
import { resolveJsonPath } from "./normalizer";

const repositoryFromPayload = { repoOwnerPath: "$.repo.owner", repoNamePath: "$.repo.name" };

describe("webhook repository configuration", () => {
  it("retains payload paths and normalizes an optional allowlist", () => {
    expect(
      triggerConfigSchema.parse({
        conditions: [],
        repositoryFromPayload: {
          ...repositoryFromPayload,
          branchPath: "$.branch",
          fallbackBranch: " release ",
          allowedRepositories: [{ repoOwner: " Group/Subgroup ", repoName: " API " }],
        },
      })
    ).toEqual({
      conditions: [],
      repositoryFromPayload: {
        ...repositoryFromPayload,
        branchPath: "$.branch",
        fallbackBranch: "release",
        allowedRepositories: [{ repoOwner: "group/subgroup", repoName: "api" }],
      },
    });
  });
  it.each(["repo.owner", "$", "$.repo[0]", "$..owner", "$.repo.*", "$.repo.", ""])(
    "rejects unsupported path %j",
    (repoOwnerPath) => {
      expect(
        triggerConfigSchema.safeParse({
          conditions: [],
          repositoryFromPayload: { ...repositoryFromPayload, repoOwnerPath },
        }).success
      ).toBe(false);
    }
  );
  it("requires both paths and a non-empty allowlist when supplied", () => {
    expect(
      triggerConfigSchema.safeParse({
        conditions: [],
        repositoryFromPayload: { repoOwnerPath: "$.owner" },
      }).success
    ).toBe(false);
    expect(
      triggerConfigSchema.safeParse({
        conditions: [],
        repositoryFromPayload: { ...repositoryFromPayload, allowedRepositories: [] },
      }).success
    ).toBe(false);
  });
  it("does not resolve inherited object properties", () => {
    expect(resolveJsonPath("$.constructor.name", {})).toBeUndefined();
    expect(resolveJsonPath("$.owner", Object.create({ owner: "acme" }))).toBeUndefined();
  });
  it("keeps fixed configuration unchanged", () => {
    expect(triggerConfigSchema.parse({ conditions: [] })).toEqual({ conditions: [] });
  });
});
