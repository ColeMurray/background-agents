import { findPrArtifactForRepo } from "@/lib/pr-artifacts";
import { getSafeExternalUrl } from "@/lib/urls";
import type { Artifact } from "@/types/session";

type PrimaryRepo = { repoOwner: string; repoName: string } | null | undefined;

export function getSessionActionState(artifacts: Artifact[], primaryRepo?: PrimaryRepo) {
  const prArtifact = primaryRepo
    ? findPrArtifactForRepo(artifacts, primaryRepo, true)
    : artifacts.find((artifact) => artifact.type === "pr");
  const previewArtifact = artifacts.find((artifact) => artifact.type === "preview");

  return {
    prArtifact,
    previewArtifact,
    prUrl: getSafeExternalUrl(prArtifact?.url),
    previewUrl: getSafeExternalUrl(previewArtifact?.url),
    mediaCount: artifacts.filter(
      (artifact) => artifact.type === "screenshot" || artifact.type === "video"
    ).length,
  };
}
