import { z } from "zod";

/** Maximum repositories a session or automation can target. */
export const MAX_TARGET_REPOSITORIES = 10;

/** Maximum repositories a session can target (alias of MAX_TARGET_REPOSITORIES). */
export const MAX_SESSION_REPOSITORIES = MAX_TARGET_REPOSITORIES;

/**
 * Fully-resolved repository reference (all fields non-null). NOT an alias of
 * AutomationRepository, whose repoId/baseBranch are nullable — the relation is
 * "RepositoryRef = the resolved flavor of it": share the input schema, keep
 * both types, convert at resolution time (toRepositoryRef).
 */
export interface RepositoryRef {
  repoOwner: string;
  repoName: string;
  repoId: number;
  baseBranch: string;
}

/**
 * Per-repo session git state; position 0 = primary. Standalone rather than
 * extending RepositoryRef: repoId is nullable because legacy synthesized
 * entries (pre-feature sessions) may lack it.
 */
export const sessionRepositoryStateSchema = z.object({
  position: z.number(),
  repoOwner: z.string(),
  repoName: z.string(),
  repoId: z.number().nullable(),
  baseBranch: z.string(),
  /** Set after the first successful push to this repo. */
  branchName: z.string().nullable(),
  baseSha: z.string().nullable(),
  currentSha: z.string().nullable(),
  /** Latest PR artifact for this repo (convenience mirror). */
  prUrl: z.string().nullable(),
});

export type SessionRepositoryState = z.infer<typeof sessionRepositoryStateSchema>;

/**
 * A session repository as carried on the session list contract
 * (Session.repositories / control-plane SessionEntry.repositories). The
 * identity subset of SessionRepositoryState — no git state, since the list
 * index doesn't store it. Ordered; [0] = primary (mirrored into the scalar
 * repoOwner/repoName columns). Control-plane's SessionIndexRepository aliases
 * this so the wire shape has a single home.
 */
export interface SessionListRepository {
  repoOwner: string;
  repoName: string;
  repoId: number | null;
  baseBranch: string;
}

/**
 * Whether a PR artifact belongs to a given session repository. Artifacts written
 * before multi-repo support carry no repo identity (`artifactRepo === null`)
 * and by construction belong to the session's primary. Identity is compared
 * case-insensitively, matching repo-identity comparison elsewhere. This is the
 * single home of that convention — the control-plane and web PR-artifact
 * lookups (each a native find over its own artifact shape) go through here.
 */
export function prArtifactBelongsToRepo(
  artifactRepo: { repoOwner: string; repoName: string } | null,
  targetRepo: { repoOwner: string; repoName: string },
  targetIsPrimary: boolean
): boolean {
  if (!artifactRepo) return targetIsPrimary;
  return (
    artifactRepo.repoOwner.toLowerCase() === targetRepo.repoOwner.toLowerCase() &&
    artifactRepo.repoName.toLowerCase() === targetRepo.repoName.toLowerCase()
  );
}

/**
 * One repository entry on a create/update request. Identifiers are normalized
 * (trim + lowercase) by the schema, matching normalizeOptionalRepositoryPair —
 * the list-entry twin of that scalar helper.
 */
export const repositoryInputSchema = z
  .object({
    repoOwner: z.string().trim().min(1),
    repoName: z.string().trim().min(1),
    baseBranch: z.string().trim().min(1).nullish(),
  })
  .transform((entry) => ({
    repoOwner: entry.repoOwner.toLowerCase(),
    repoName: entry.repoName.toLowerCase(),
    baseBranch: entry.baseBranch ?? null,
  }));

export type RepositoryInput = z.input<typeof repositoryInputSchema>;

/** Repository list for create/update requests: bounded and duplicate-free. */
export const repositoriesInputSchema = z
  .array(repositoryInputSchema)
  .max(MAX_TARGET_REPOSITORIES, {
    message: `repositories must contain at most ${MAX_TARGET_REPOSITORIES} entries`,
  })
  .superRefine((repositories, ctx) => {
    const seen = new Set<string>();
    repositories.forEach((repository, index) => {
      const key = `${repository.repoOwner}/${repository.repoName}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate repository: ${key}`,
          path: [index],
        });
      }
      seen.add(key);
    });
  });

/**
 * Session flavor of the list: additionally rejects empty lists (the field is
 * either absent — scalar-era request — or names at least one repository, so an
 * empty array never masquerades as a third mode) and duplicate repoName
 * across different owners — clone paths are /workspace/{repoName}, and a
 * clear 400 beats path disambiguation.
 */
export const sessionRepositoriesInputSchema = repositoriesInputSchema.superRefine(
  (repositories, ctx) => {
    if (repositories.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "repositories must contain at least one entry (omit the field instead)",
      });
    }
    const seenNames = new Set<string>();
    repositories.forEach((repository, index) => {
      if (seenNames.has(repository.repoName)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate repository name: ${repository.repoName} (checkout paths are /workspace/{repoName})`,
          path: [index],
        });
      }
      seenNames.add(repository.repoName);
    });
  }
);

export interface RepositoryPair {
  repoOwner: string;
  repoName: string;
}

export class RepositoryPairValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepositoryPairValidationError";
  }
}

/**
 * Normalize an optional repository pair: trim + lowercase identifiers, map a
 * blank pair to null. The single write-side normalization for scalar repo
 * pairs — routes, stores, and resolvers must not roll their own.
 *
 * @throws RepositoryPairValidationError when only one identifier is present.
 */
export function normalizeOptionalRepositoryPair(
  input: { repoOwner?: string | null; repoName?: string | null },
  partialMessage = "repoOwner and repoName must be provided together"
): RepositoryPair | null {
  const repoOwner = input.repoOwner?.trim().toLowerCase() || null;
  const repoName = input.repoName?.trim().toLowerCase() || null;

  if ((repoOwner === null) !== (repoName === null)) {
    throw new RepositoryPairValidationError(partialMessage);
  }

  return repoOwner && repoName ? { repoOwner, repoName } : null;
}
