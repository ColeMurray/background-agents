import { describe, expect, it } from "vitest";
import { decodeRepositoryShas, parseRepositoryShasJson, repositoryIdentityKey } from "./provenance";

describe("image build provenance", () => {
  it("decodes the persisted repository SHA contract", () => {
    const repositories = [{ repoOwner: "Acme", repoName: "Web", baseSha: "abc123" }];

    expect(decodeRepositoryShas(repositories)).toEqual(repositories);
    expect(parseRepositoryShasJson(JSON.stringify(repositories))).toEqual(repositories);
  });

  it("rejects malformed or empty repository identities", () => {
    expect(decodeRepositoryShas({})).toBeNull();
    expect(decodeRepositoryShas([null])).toBeNull();
    expect(
      decodeRepositoryShas([{ repoOwner: "", repoName: "web", baseSha: "abc123" }])
    ).toBeNull();
    expect(parseRepositoryShasJson("not-json")).toBeNull();
  });

  it("uses one case-insensitive repository identity key", () => {
    expect(repositoryIdentityKey({ repoOwner: "Acme", repoName: "Web" })).toBe("acme/web");
  });
});
