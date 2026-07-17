import { z } from "zod";
import { MAX_SESSION_REPOSITORIES } from "./repositories";

export const SESSION_DIFF_VERSION = 1 as const;
export const SESSION_DIFF_MAX_FILES = 1_000;
export const SESSION_DIFF_MAX_PATCH_BYTES = 1_000_000;
export const SESSION_DIFF_MAX_CAPTURE_BYTES = 20_000_000;
export const SESSION_DIFF_CAPTURE_TIMEOUT_MS = 60_000;

export const diffAttemptStatusSchema = z.enum(["idle", "capturing", "failed"]);
export const diffBaselineStatusSchema = z.enum(["pending", "ready", "unavailable"]);
export const diffRepositoryStatusSchema = z.enum(["ready", "stale", "unavailable"]);
export const diffRenderStateSchema = z.enum(["renderable", "binary", "too_large", "metadata_only"]);
export const diffFileStatusSchema = z.enum([
  "added",
  "modified",
  "deleted",
  "renamed",
  "type_changed",
  "unmerged",
  "submodule",
]);

const nonEmptyIdSchema = z.string().trim().min(1).max(200);
const gitShaSchema = z.string().regex(/^[0-9a-f]{40,64}$/i, "Expected a Git object SHA");
const repositoryOwnerSchema = z.string().trim().min(1).max(300);
const repositoryNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((name) => !name.includes("/"), {
    message: "Repository name cannot contain a slash",
  });
const repositoryPathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine((path) => !path.includes("\0"), {
    message: "Repository path cannot contain NUL",
  });

export const sessionDiffBaselineRepositorySchema = z.object({
  position: z.number().int().nonnegative(),
  repoOwner: repositoryOwnerSchema,
  repoName: repositoryNameSchema,
  baseSha: gitShaSchema,
});

export const sessionDiffFileSchema = z
  .object({
    id: nonEmptyIdSchema,
    path: repositoryPathSchema,
    oldPath: repositoryPathSchema.optional(),
    status: diffFileStatusSchema,
    additions: z.number().int().nonnegative().nullable(),
    deletions: z.number().int().nonnegative().nullable(),
    renderState: diffRenderStateSchema,
    patchBytes: z.number().int().positive().max(SESSION_DIFF_MAX_PATCH_BYTES).optional(),
    oldMode: z.string().optional(),
    newMode: z.string().optional(),
    oldSubmoduleSha: gitShaSchema.optional(),
    newSubmoduleSha: gitShaSchema.optional(),
  })
  .superRefine((file, ctx) => {
    if (file.renderState === "renderable" && file.patchBytes === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "Renderable files require patchBytes",
        path: ["patchBytes"],
      });
    }
    if (file.renderState !== "renderable" && file.patchBytes !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "Non-renderable files cannot include patchBytes",
        path: ["patchBytes"],
      });
    }
  });

function validateUniqueRepositoryFiles(
  files: ReadonlyArray<{ id: string; path: string }>,
  ctx: z.RefinementCtx
): void {
  const ids = new Set<string>();
  const paths = new Set<string>();
  files.forEach((file, index) => {
    if (ids.has(file.id)) {
      ctx.addIssue({
        code: "custom",
        message: `Duplicate diff file id: ${file.id}`,
        path: ["files", index, "id"],
      });
    }
    if (paths.has(file.path)) {
      ctx.addIssue({
        code: "custom",
        message: `Duplicate diff file path: ${file.path}`,
        path: ["files", index, "path"],
      });
    }
    ids.add(file.id);
    paths.add(file.path);
  });
}

export const sessionDiffRepositorySchema = z
  .object({
    position: z.number().int().nonnegative(),
    repoOwner: repositoryOwnerSchema,
    repoName: repositoryNameSchema,
    baseSha: gitShaSchema,
    headSha: gitShaSchema,
    capturedAt: z.number().int().nonnegative(),
    status: diffRepositoryStatusSchema,
    sourceCaptureId: nonEmptyIdSchema,
    truncated: z.boolean(),
    omittedFileCount: z.number().int().nonnegative(),
    error: z.string().max(2_000).optional(),
    files: z.array(sessionDiffFileSchema).max(SESSION_DIFF_MAX_FILES),
  })
  .superRefine((repository, ctx) => {
    validateUniqueRepositoryFiles(repository.files, ctx);
  });

export const sessionDiffManifestSchema = z
  .object({
    revisionId: nonEmptyIdSchema,
    capturedAt: z.number().int().nonnegative(),
    triggerMessageId: nonEmptyIdSchema.nullable(),
    repositories: z.array(sessionDiffRepositorySchema).max(MAX_SESSION_REPOSITORIES),
  })
  .superRefine(({ repositories }, ctx) => {
    const fileIds = new Set<string>();
    repositories.forEach((repository, repositoryIndex) => {
      repository.files.forEach((file, fileIndex) => {
        if (fileIds.has(file.id)) {
          ctx.addIssue({
            code: "custom",
            message: `Duplicate diff file id: ${file.id}`,
            path: ["repositories", repositoryIndex, "files", fileIndex, "id"],
          });
        }
        fileIds.add(file.id);
      });
    });
  });

export const sessionDiffStateSchema = z.object({
  version: z.literal(SESSION_DIFF_VERSION),
  baseline: z.object({
    status: diffBaselineStatusSchema,
    reason: z.string().max(2_000).nullable(),
  }),
  attempt: z.object({
    id: nonEmptyIdSchema.nullable(),
    status: diffAttemptStatusSchema,
    startedAt: z.number().int().nonnegative().nullable(),
    error: z.string().max(2_000).nullable(),
  }),
  current: sessionDiffManifestSchema.nullable(),
});

export const diffCaptureLimitsSchema = z.object({
  maxFiles: z.number().int().positive().max(SESSION_DIFF_MAX_FILES),
  maxPatchBytes: z.number().int().positive().max(SESSION_DIFF_MAX_PATCH_BYTES),
  maxCaptureBytes: z.number().int().positive().max(SESSION_DIFF_MAX_CAPTURE_BYTES),
  timeoutMs: z.number().int().positive().max(SESSION_DIFF_CAPTURE_TIMEOUT_MS),
});

const diffCaptureRepositoryIdentitySchema = z.object({
  position: z.number().int().nonnegative(),
  repoOwner: repositoryOwnerSchema,
  repoName: repositoryNameSchema,
  baseSha: gitShaSchema,
});

export const diffCaptureRepositorySuccessSchema = diffCaptureRepositoryIdentitySchema
  .extend({
    headSha: gitShaSchema,
    truncated: z.boolean(),
    omittedFileCount: z.number().int().nonnegative(),
    files: z.array(sessionDiffFileSchema).max(SESSION_DIFF_MAX_FILES),
  })
  .superRefine((repository, ctx) => {
    validateUniqueRepositoryFiles(repository.files, ctx);
  });

export const diffCaptureRepositoryFailureSchema = diffCaptureRepositoryIdentitySchema.extend({
  error: z.string().trim().min(1).max(2_000),
});

export const diffCaptureRepositoryOutcomeSchema = z.union([
  diffCaptureRepositorySuccessSchema,
  diffCaptureRepositoryFailureSchema,
]);

export const diffCaptureCompleteRequestSchema = z
  .object({
    repositories: z.array(diffCaptureRepositoryOutcomeSchema).min(1).max(MAX_SESSION_REPOSITORIES),
  })
  .superRefine(({ repositories }, ctx) => {
    const positions = new Set<number>();
    const fileIds = new Set<string>();
    let fileCount = 0;
    let patchBytes = 0;
    repositories.forEach((repository, index) => {
      if (positions.has(repository.position)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate repository position: ${repository.position}`,
          path: ["repositories", index, "position"],
        });
      }
      positions.add(repository.position);
      if ("files" in repository) {
        fileCount += repository.files.length;
        repository.files.forEach((file, fileIndex) => {
          if (fileIds.has(file.id)) {
            ctx.addIssue({
              code: "custom",
              message: `Duplicate diff file id: ${file.id}`,
              path: ["repositories", index, "files", fileIndex, "id"],
            });
          }
          fileIds.add(file.id);
          patchBytes += file.patchBytes ?? 0;
        });
      }
    });
    if (fileCount > SESSION_DIFF_MAX_FILES) {
      ctx.addIssue({
        code: "custom",
        message: `A capture cannot include more than ${SESSION_DIFF_MAX_FILES.toLocaleString("en-US")} files`,
        path: ["repositories"],
      });
    }
    if (patchBytes > SESSION_DIFF_MAX_CAPTURE_BYTES) {
      ctx.addIssue({
        code: "custom",
        message: `A capture cannot include more than ${SESSION_DIFF_MAX_CAPTURE_BYTES.toLocaleString("en-US")} patch bytes`,
        path: ["repositories"],
      });
    }
  });

export const diffCaptureFailureRequestSchema = z.object({
  error: z.string().trim().min(1).max(2_000),
});

export type DiffAttemptStatus = z.infer<typeof diffAttemptStatusSchema>;
export type DiffBaselineStatus = z.infer<typeof diffBaselineStatusSchema>;
export type DiffRepositoryStatus = z.infer<typeof diffRepositoryStatusSchema>;
export type DiffRenderState = z.infer<typeof diffRenderStateSchema>;
export type DiffFileStatus = z.infer<typeof diffFileStatusSchema>;
export type SessionDiffBaselineRepository = z.infer<typeof sessionDiffBaselineRepositorySchema>;
export type SessionDiffFile = z.infer<typeof sessionDiffFileSchema>;
export type SessionDiffRepository = z.infer<typeof sessionDiffRepositorySchema>;
export type SessionDiffManifest = z.infer<typeof sessionDiffManifestSchema>;
export type SessionDiffState = z.infer<typeof sessionDiffStateSchema>;
export type DiffCaptureLimits = z.infer<typeof diffCaptureLimitsSchema>;
export type DiffCaptureRepositorySuccess = z.infer<typeof diffCaptureRepositorySuccessSchema>;
export type DiffCaptureRepositoryFailure = z.infer<typeof diffCaptureRepositoryFailureSchema>;
export type DiffCaptureRepositoryOutcome = z.infer<typeof diffCaptureRepositoryOutcomeSchema>;
export type DiffCaptureCompleteRequest = z.infer<typeof diffCaptureCompleteRequestSchema>;
export type DiffCaptureFailureRequest = z.infer<typeof diffCaptureFailureRequestSchema>;
