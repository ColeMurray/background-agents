export type RepoImageProvider = "modal" | "vercel" | "opencomputer";
export type RepoImageBuildStatus = "building" | "ready" | "failed" | "superseded";

export interface RepoImageProviderImageRef {
  providerImageId: string;
  providerSessionId?: string | null;
}

export interface SupersededRepoImage {
  repoImageId: string;
  image: RepoImageProviderImageRef;
}

export type MarkRepoImageReadyResult =
  | { type: "marked_ready"; supersededImages: SupersededRepoImage[] }
  | { type: "superseded_by_newer_ready"; supersededImage: SupersededRepoImage }
  | { type: "not_accepting_completion" };

export interface RepoImageCallbackBuild {
  id: string;
  provider: RepoImageProvider;
  providerSessionId: string | null;
  status: RepoImageBuildStatus;
}
