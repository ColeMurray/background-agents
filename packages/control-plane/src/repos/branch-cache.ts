import { z } from "zod";

export const BRANCHES_CACHE_FRESH_MS = 60 * 1000;
export const BRANCHES_CACHE_TTL_MS = 60 * 60 * 1000;

export function branchesCacheKey(owner: string, name: string): string {
  return `repos:branches:v1:${owner.toLowerCase()}/${name.toLowerCase()}`;
}

export const cachedBranchesListSchema = z.object({
  branches: z.array(z.object({ name: z.string() })),
  cachedAt: z.string(),
  scmIdentity: z.string(),
  freshUntil: z.number(),
});

export type CachedBranchesList = z.infer<typeof cachedBranchesListSchema>;
