/**
 * Unit tests for spawn-time prebuilt-image selection.
 */

import { describe, it, expect } from "vitest";
import { evaluateImageBuildForSpawn, type ImageBuildSpawnRow } from "./image-selection";
import { computeRepositoriesFingerprint } from "../../image-builds/fingerprint";
import { COMPATIBLE_RUNTIME_VERSION } from "../../image-builds/test-helpers";

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
    runtime_version: COMPATIBLE_RUNTIME_VERSION,
    ...overrides,
  };
}

describe("evaluateImageBuildForSpawn", () => {
  it.each(["claude", "opencode"] as const)(
    "rejects pre-memory v73 images for %s",
    async (harness) => {
      const image = await readyImage({ runtime_version: "v73-node-24" });
      expect(await evaluateImageBuildForSpawn(image, SESSION_REPOSITORIES, harness)).toEqual({
        outcome: "miss",
        reason: "runtime_below_floor",
        imageBuildId: "imgb-1",
      });
    }
  );
});
