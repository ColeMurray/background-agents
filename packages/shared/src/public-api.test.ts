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

  it("exports provider account contracts from the package root", () => {
    expect(shared.SUBSCRIPTION_PROVIDER_IDS).toEqual(["openai", "xai"]);
    expect(
      shared.modelProviderSelectionsSchema.safeParse({ xai: { mode: "api_key" } }).success
    ).toBe(true);
  });

  it("exports GitHub Autofix contracts from the package root", () => {
    expect(
      shared.githubAutofixEnvelopeSchema.safeParse({
        version: 1,
        eventType: "issue_comment",
        action: "created",
        deliveryId: "delivery-1",
        providerObject: { kind: "pr_comment", id: "123" },
        repository: { id: "456", owner: "acme", name: "widgets" },
        pullRequestNumber: 42,
        receivedAt: "2026-08-26T12:00:00.000Z",
      }).success
    ).toBe(true);
  });
});
