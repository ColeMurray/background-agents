import { describe, expect, it } from "vitest";
import { repositoryParams } from "./repository-params";

describe("repositoryParams", () => {
  it("accepts a nested owner namespace Hono decoded from one segment", () => {
    expect(repositoryParams({ owner: "group/subgroup", name: "web" })).toEqual({
      owner: "group/subgroup",
      name: "web",
    });
  });

  it("rejects a slash in the repository name with the route's 400", async () => {
    const result = repositoryParams({ owner: "group", name: "web/api" });

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(400);
    await expect((result as Response).json()).resolves.toEqual({
      error: "Owner and name must be valid repository path segments",
    });
  });
});
