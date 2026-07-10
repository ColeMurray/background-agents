/**
 * Unit tests for spawn-time prebuilt-image selection.
 */

import { describe, it, expect } from "vitest";
import { evaluateImageBuildForSpawn, type ImageBuildSpawnRow } from "./image-selection";
import { computeRepositoriesFingerprint } from "../../image-builds/fingerprint";

const SESSION_REPOSITORIES = [
  { repoOwner: "acme", repoName: "web", baseBranch: "main" },
  { repoOwner: "acme", repoName: "api", baseBranch: "develop" },
];

async function readyImage(
  overrides: Partial<ImageBuildSpawnRow> = {}
): Promise<ImageBuildSpawnRow> {
  return {
    id: "imgb-1",
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

describe("evaluateImageBuildForSpawn", () => {
  it("selects a ready image matching the session's own snapshot", async () => {
    const result = await evaluateImageBuildForSpawn(await readyImage(), SESSION_REPOSITORIES);

    expect(result).toEqual({
      outcome: "selected",
      image: {
        imageBuildId: "imgb-1",
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
    expect((await evaluateImageBuildForSpawn(image, SESSION_REPOSITORIES)).outcome).toBe(
      "selected"
    );

    const branchCased = await readyImage({
      repositories_fingerprint: await computeRepositoriesFingerprint([
        { repoOwner: "acme", repoName: "web", baseBranch: "Main" },
        { repoOwner: "acme", repoName: "api", baseBranch: "develop" },
      ]),
    });
    expect(await evaluateImageBuildForSpawn(branchCased, SESSION_REPOSITORIES)).toEqual({
      outcome: "miss",
      reason: "fingerprint_mismatch",
      imageBuildId: "imgb-1",
    });
  });

  it("misses when no ready image exists", async () => {
    expect(await evaluateImageBuildForSpawn(null, SESSION_REPOSITORIES)).toEqual({
      outcome: "miss",
      reason: "no_ready_image",
    });
  });

  it("misses on a ready row without a provider artifact", async () => {
    const image = await readyImage({ provider_image_id: null });

    expect(await evaluateImageBuildForSpawn(image, SESSION_REPOSITORIES)).toEqual({
      outcome: "miss",
      reason: "missing_artifact",
      imageBuildId: "imgb-1",
    });
  });

  it("misses below the runtime floor and fails closed on an unparseable version", async () => {
    for (const runtimeVersion of ["v52-pre-list-runtime", "dev", ""]) {
      const image = await readyImage({ runtime_version: runtimeVersion });

      expect(await evaluateImageBuildForSpawn(image, SESSION_REPOSITORIES)).toEqual({
        outcome: "miss",
        reason: "runtime_below_floor",
        imageBuildId: "imgb-1",
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

    expect(await evaluateImageBuildForSpawn(image, SESSION_REPOSITORIES)).toEqual({
      outcome: "miss",
      reason: "fingerprint_mismatch",
      imageBuildId: "imgb-1",
    });
  });

  it("misses when the session's repositories are reordered relative to the build", async () => {
    const reordered = [SESSION_REPOSITORIES[1], SESSION_REPOSITORIES[0]];

    expect((await evaluateImageBuildForSpawn(await readyImage(), reordered)).outcome).toBe("miss");
  });

  it("still selects when the provenance document is malformed — the SHA is informational", async () => {
    for (const repositoryShas of ["not json", "[]", '[{"repoOwner":"acme"}]', '"scalar"']) {
      const image = await readyImage({ repository_shas: repositoryShas });
      const result = await evaluateImageBuildForSpawn(image, SESSION_REPOSITORIES);

      expect(result.outcome).toBe("selected");
      if (result.outcome === "selected") {
        expect(result.image.primaryBaseSha).toBeNull();
      }
    }
  });
});
