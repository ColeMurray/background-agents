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
});
