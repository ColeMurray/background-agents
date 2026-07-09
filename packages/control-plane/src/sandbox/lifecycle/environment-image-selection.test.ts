/**
 * Unit tests for spawn-time environment-image selection (design §7.3).
 */

import { describe, it, expect } from "vitest";
import {
  evaluateEnvironmentImageForSpawn,
  type EnvironmentImageSpawnRow,
} from "./environment-image-selection";
import { computeRepositoriesFingerprint } from "../../environment-images/fingerprint";

const SESSION_REPOSITORIES = [
  { repoOwner: "acme", repoName: "web", baseBranch: "main" },
  { repoOwner: "acme", repoName: "api", baseBranch: "develop" },
];

async function readyImage(
  overrides: Partial<EnvironmentImageSpawnRow> = {}
): Promise<EnvironmentImageSpawnRow> {
  return {
    id: "envimg-1",
    provider_image_id: "im-abc123",
    repositories_fingerprint: await computeRepositoriesFingerprint(SESSION_REPOSITORIES),
    repository_shas: JSON.stringify([
      { repoOwner: "acme", repoName: "web", baseSha: "sha-web" },
      { repoOwner: "acme", repoName: "api", baseSha: "sha-api" },
    ]),
    runtime_version: "v53-list-native-runtime",
    ...overrides,
  };
}

describe("evaluateEnvironmentImageForSpawn", () => {
  it("selects a ready image matching the session's own snapshot", async () => {
    const result = await evaluateEnvironmentImageForSpawn(await readyImage(), SESSION_REPOSITORIES);

    expect(result).toEqual({
      outcome: "selected",
      image: {
        environmentImageId: "envimg-1",
        providerImageId: "im-abc123",
        primaryBaseSha: "sha-web",
        runtimeVersion: "v53-list-native-runtime",
      },
    });
  });

  it("matches repository identity case-insensitively but branches case-sensitively", async () => {
    const image = await readyImage({
      repositories_fingerprint: await computeRepositoriesFingerprint([
        { repoOwner: "Acme", repoName: "Web", baseBranch: "main" },
        { repoOwner: "ACME", repoName: "api", baseBranch: "develop" },
      ]),
    });
    expect((await evaluateEnvironmentImageForSpawn(image, SESSION_REPOSITORIES)).outcome).toBe(
      "selected"
    );

    const branchCased = await readyImage({
      repositories_fingerprint: await computeRepositoriesFingerprint([
        { repoOwner: "acme", repoName: "web", baseBranch: "Main" },
        { repoOwner: "acme", repoName: "api", baseBranch: "develop" },
      ]),
    });
    expect(await evaluateEnvironmentImageForSpawn(branchCased, SESSION_REPOSITORIES)).toEqual({
      outcome: "miss",
      reason: "fingerprint_mismatch",
      environmentImageId: "envimg-1",
    });
  });

  it("misses when no ready image exists", async () => {
    expect(await evaluateEnvironmentImageForSpawn(null, SESSION_REPOSITORIES)).toEqual({
      outcome: "miss",
      reason: "no_ready_image",
    });
  });

  it("misses on a ready row without a provider artifact", async () => {
    const image = await readyImage({ provider_image_id: null });

    expect(await evaluateEnvironmentImageForSpawn(image, SESSION_REPOSITORIES)).toEqual({
      outcome: "miss",
      reason: "missing_artifact",
      environmentImageId: "envimg-1",
    });
  });

  it("misses below the runtime floor and fails closed on an unparseable version", async () => {
    for (const runtimeVersion of ["v52-pre-list-runtime", "dev", ""]) {
      const image = await readyImage({ runtime_version: runtimeVersion });

      expect(await evaluateEnvironmentImageForSpawn(image, SESSION_REPOSITORIES)).toEqual({
        outcome: "miss",
        reason: "runtime_below_floor",
        environmentImageId: "envimg-1",
      });
    }
  });

  it("misses when the environment was edited after the session was created", async () => {
    // The image was built from the environment's CURRENT repositories; the
    // session's own snapshot predates the edit and must not receive it.
    const image = await readyImage({
      repositories_fingerprint: await computeRepositoriesFingerprint([
        { repoOwner: "acme", repoName: "web", baseBranch: "main" },
        { repoOwner: "acme", repoName: "api", baseBranch: "release" },
      ]),
    });

    expect(await evaluateEnvironmentImageForSpawn(image, SESSION_REPOSITORIES)).toEqual({
      outcome: "miss",
      reason: "fingerprint_mismatch",
      environmentImageId: "envimg-1",
    });
  });

  it("misses when the session's repositories are reordered relative to the build", async () => {
    const reordered = [SESSION_REPOSITORIES[1], SESSION_REPOSITORIES[0]];

    expect((await evaluateEnvironmentImageForSpawn(await readyImage(), reordered)).outcome).toBe(
      "miss"
    );
  });

  it("still selects when the provenance document is malformed — the SHA is informational", async () => {
    for (const repositoryShas of ["not json", "[]", '[{"repoOwner":"acme"}]', '"scalar"']) {
      const image = await readyImage({ repository_shas: repositoryShas });
      const result = await evaluateEnvironmentImageForSpawn(image, SESSION_REPOSITORIES);

      expect(result.outcome).toBe("selected");
      if (result.outcome === "selected") {
        expect(result.image.primaryBaseSha).toBeNull();
      }
    }
  });
});
