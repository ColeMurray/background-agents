import { describe, expect, it } from "vitest";
import * as shared from "./index";

describe("package root compatibility", () => {
  it("preserves repository schema aliases", () => {
    expect(shared.automationRepositoryInputSchema).toBe(shared.repositoryInputSchema);
    expect(shared.automationRepositoriesInputSchema).toBe(shared.repositoriesInputSchema);
    expect(shared.environmentRepositoriesInputSchema).toBe(shared.sessionRepositoriesInputSchema);
    expect(shared.MAX_AUTOMATION_REPOSITORIES).toBe(shared.MAX_TARGET_REPOSITORIES);
    expect(shared.MAX_SESSION_REPOSITORIES).toBe(shared.MAX_TARGET_REPOSITORIES);
  });

  it("uses the public RepositoryPairValidationError constructor", () => {
    expect(() => shared.normalizeOptionalRepositoryPair({ repoOwner: "acme" })).toThrow(
      shared.RepositoryPairValidationError
    );
  });
});
