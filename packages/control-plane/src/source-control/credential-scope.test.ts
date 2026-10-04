import { describe, expect, it } from "vitest";
import { repositoryCredentialScope } from "./credential-scope";
import { SourceControlProviderError } from "./errors";

describe("repositoryCredentialScope", () => {
  it("sorts and de-duplicates the exact repository set", () => {
    expect(repositoryCredentialScope([30, 2, 30])).toEqual({
      kind: "repositories",
      repositoryIds: [2, 30],
    });
  });

  it("accepts 500 unique ids even when the input includes duplicates", () => {
    const ids = Array.from({ length: 500 }, (_, i) => i + 1);
    expect(repositoryCredentialScope([...ids, ...ids]).repositoryIds).toEqual(ids);
  });

  it("refuses more than 500 unique ids without truncating the set", () => {
    expect(() => repositoryCredentialScope(Array.from({ length: 501 }, (_, i) => i + 1))).toThrow(
      "500"
    );
  });

  it.each([[], [0], [-1], [1.5], [NaN], [Number.MAX_SAFE_INTEGER + 1]].map((ids) => ({ ids })))(
    "refuses invalid or empty ids $ids with a permanent credential error",
    ({ ids }) => {
      try {
        repositoryCredentialScope(ids);
        expect.fail("Expected invalid repository scope to be refused");
      } catch (error) {
        expect(error).toBeInstanceOf(SourceControlProviderError);
        expect(error).toMatchObject({ errorType: "permanent" });
      }
    }
  );
});
