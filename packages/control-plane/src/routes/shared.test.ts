import { describe, expect, it } from "vitest";
import { extractRepoParams, parsePattern } from "./shared";

describe("repository route parameters", () => {
  it("decodes a nested owner namespace from one URL segment", () => {
    const match = "/repos/group%2Fsubgroup/web/branches".match(
      parsePattern("/repos/:owner/:name/branches")
    );

    expect(match).not.toBeNull();
    expect(extractRepoParams(match!)).toEqual({ owner: "group/subgroup", name: "web" });
  });

  it("rejects an encoded slash in the repository name", async () => {
    const match = "/repos/group/web%2Fapi/branches".match(
      parsePattern("/repos/:owner/:name/branches")
    );

    const result = extractRepoParams(match!);

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(400);
    await expect((result as Response).json()).resolves.toEqual({
      error: "Owner and name must be valid repository path segments",
    });
  });
});
