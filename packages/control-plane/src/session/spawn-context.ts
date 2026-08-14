import { isValidSandboxTimeoutMs } from "@open-inspect/shared/types/integrations";
import { z } from "zod";

const sandboxTimeoutMsSchema = z.number().refine(isValidSandboxTimeoutMs);

/**
 * Returned by the parent Durable Object's GET /internal/spawn-context.
 *
 * Deliberately scalar in v1: child sessions inherit — and are restricted to —
 * the parent's PRIMARY repository, even for multi-repo parents. The spawn
 * route validates against the scalar mirror. Letting children target another
 * repository requires spawnContext.repositories, a named fast-follow (design
 * §13.13), not a v1 promise.
 */
const promptAuthorSchema = z.object({
  userId: z.string(),
  canonicalUserId: z.string().nullable().optional(),
  scmUserId: z.string().nullable(),
  scmLogin: z.string().nullable(),
  scmName: z.string().nullable(),
  scmEmail: z.string().nullable(),
  scmAccessTokenEncrypted: z.string().nullable(),
  scmRefreshTokenEncrypted: z.string().nullable(),
  scmTokenExpiresAt: z.number().nullable(),
});

export const spawnContextSchema = z.object({
  repoOwner: z.string().nullable(),
  repoName: z.string().nullable(),
  repoId: z.number().nullable(),
  model: z.string(),
  reasoningEffort: z.string().nullable(),
  baseBranch: z.string().nullable(),
  sandboxTimeoutMs: sandboxTimeoutMsSchema.optional(),
  promptAuthor: promptAuthorSchema,
});

export type SpawnContext = z.infer<typeof spawnContextSchema>;
