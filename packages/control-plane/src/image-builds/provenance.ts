import type { RepositoryShaEntry } from "@open-inspect/shared/types/image-builds";
import { z } from "zod";

type RepositoryIdentity = Pick<RepositoryShaEntry, "repoOwner" | "repoName">;

/** Stable case-insensitive identity shared by provenance and branch reconciliation. */
export function repositoryIdentityKey(repository: RepositoryIdentity): string {
  return `${repository.repoOwner.toLowerCase()}/${repository.repoName.toLowerCase()}`;
}

/**
 * Canonical schema for one repository provenance entry — the single
 * cross-language shape produced by the runtime ({repoOwner, repoName,
 * baseSha}, all non-empty). Callback bodies and persisted rows both validate
 * against this; unknown keys are dropped by projection.
 */
export const repositoryShaEntrySchema = z.object({
  repoOwner: z.string().min(1),
  repoName: z.string().min(1),
  baseSha: z.string().min(1),
});

const repositoryShasSchema = z.array(repositoryShaEntrySchema);

/** Decode the repository SHA document used by callbacks and persisted build rows. */
export function decodeRepositoryShas(value: unknown): RepositoryShaEntry[] | null {
  const parsed = repositoryShasSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Parse and decode a D1 JSON provenance column without leaking exceptions. */
export function parseRepositoryShasJson(value: string): RepositoryShaEntry[] | null {
  try {
    return decodeRepositoryShas(JSON.parse(value));
  } catch {
    return null;
  }
}
