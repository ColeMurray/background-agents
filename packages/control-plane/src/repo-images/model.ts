/**
 * Domain terms shared across repo image planning, storage, and session startup.
 *
 * A repo image is a provider-opaque prebuilt environment artifact: Modal stores
 * an image id, Vercel stores a snapshot id, and OpenComputer stores a checkpoint
 * id. Code outside provider adapters should treat those ids as opaque.
 */
import type { ImageBuildProvider } from "../image-builds/model";

/** Same provider set as the unified image-build subsystem. */
export type RepoImageProvider = ImageBuildProvider;
export type RepoImageBuildStatus = "building" | "ready" | "failed" | "superseded";

/** Opaque provider artifact reference, optionally tied to the build sandbox that produced it. */
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

/** Minimal build row shape needed before accepting a callback. */
export interface RepoImageCallbackBuild {
  id: string;
  provider: RepoImageProvider;
  providerSessionId: string | null;
  status: RepoImageBuildStatus;
}
