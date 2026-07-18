import { z } from "zod";
import { MAX_SESSION_REPOSITORIES } from "./repositories";

export const SESSION_DIFF_VERSION = 1 as const;
export const SESSION_DIFF_MAX_FILES = 1_000;
export const SESSION_DIFF_MAX_FILE_PATCH_BYTES = 512 * 1_024;
export const SESSION_DIFF_MAX_TOTAL_PATCH_BYTES = 1_024 * 1_024;
export const SESSION_DIFF_MAX_BUNDLE_BYTES = 1_572_864;
export const SESSION_DIFF_MAX_ERROR_LENGTH = 2_000;
export const SESSION_DIFF_REFRESH_TIMEOUT_MS = 60_000;

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
const errorSchema = z.string().trim().min(1).max(SESSION_DIFF_MAX_ERROR_LENGTH);

export const sessionDiffBaselineRepositorySchema = z.object({
  position: z.number().int().nonnegative(),
  repoOwner: repositoryOwnerSchema,
  repoName: repositoryNameSchema,
  baseSha: gitShaSchema,
});

const sessionDiffFileShape = {
  id: nonEmptyIdSchema,
  path: repositoryPathSchema,
  oldPath: repositoryPathSchema.optional(),
  status: diffFileStatusSchema,
  additions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable(),
  renderState: diffRenderStateSchema,
  oldMode: z.string().max(20).optional(),
  newMode: z.string().max(20).optional(),
  oldSubmoduleSha: gitShaSchema.optional(),
  newSubmoduleSha: gitShaSchema.optional(),
};

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function validateFilePatch(
  file: z.infer<z.ZodObject<typeof sessionDiffFileShape & { patch: z.ZodOptional<z.ZodString> }>>,
  ctx: z.RefinementCtx
): void {
  if (file.oldPath !== undefined && file.status !== "renamed") {
    ctx.addIssue({
      code: "custom",
      message: "oldPath is only valid for renamed files",
      path: ["oldPath"],
    });
  }
  if (file.renderState === "renderable" && file.patch === undefined) {
    ctx.addIssue({
      code: "custom",
      message: "Renderable files require a patch",
      path: ["patch"],
    });
  }
  if (file.renderState !== "renderable" && file.patch !== undefined) {
    ctx.addIssue({
      code: "custom",
      message: "Non-renderable files cannot include a patch",
      path: ["patch"],
    });
  }
  if (file.patch !== undefined && utf8Bytes(file.patch) > SESSION_DIFF_MAX_FILE_PATCH_BYTES) {
    ctx.addIssue({
      code: "custom",
      message: `Patch exceeds ${SESSION_DIFF_MAX_FILE_PATCH_BYTES} UTF-8 bytes`,
      path: ["patch"],
    });
  }
}

export const sessionDiffFileUploadSchema = z
  .object({
    ...sessionDiffFileShape,
    patch: z.string().min(1).optional(),
  })
  .superRefine(validateFilePatch);

export const sessionDiffFileSchema = z.object(sessionDiffFileShape).superRefine((file, ctx) => {
  if (file.oldPath !== undefined && file.status !== "renamed") {
    ctx.addIssue({
      code: "custom",
      message: "oldPath is only valid for renamed files",
      path: ["oldPath"],
    });
  }
});

const repositoryIdentityShape = {
  position: z.number().int().nonnegative(),
  repoOwner: repositoryOwnerSchema,
  repoName: repositoryNameSchema,
  baseSha: gitShaSchema,
};

const readyRepositoryUploadSchema = z.object({
  status: z.literal("ready"),
  ...repositoryIdentityShape,
  headSha: gitShaSchema,
  truncated: z.boolean(),
  omittedFileCount: z.number().int().nonnegative(),
  files: z.array(sessionDiffFileUploadSchema),
});

const unavailableRepositoryUploadSchema = z.object({
  status: z.literal("unavailable"),
  ...repositoryIdentityShape,
  error: errorSchema,
  files: z.tuple([]),
});

export const sessionDiffRepositoryUploadSchema = z.discriminatedUnion("status", [
  readyRepositoryUploadSchema,
  unavailableRepositoryUploadSchema,
]);

const readyRepositorySchema = z.object({
  status: z.literal("ready"),
  ...repositoryIdentityShape,
  headSha: gitShaSchema,
  truncated: z.boolean(),
  omittedFileCount: z.number().int().nonnegative(),
  files: z.array(sessionDiffFileSchema),
});

const unavailableRepositorySchema = z.object({
  status: z.literal("unavailable"),
  ...repositoryIdentityShape,
  error: errorSchema,
  files: z.tuple([]),
});

export const sessionDiffRepositorySchema = z.discriminatedUnion("status", [
  readyRepositorySchema,
  unavailableRepositorySchema,
]);

type BundleRepository = {
  position: number;
  repoOwner: string;
  repoName: string;
  files: ReadonlyArray<{ id: string; path: string; patch?: string }>;
};

function validateBundle(
  value: { repositories: ReadonlyArray<BundleRepository> },
  ctx: z.RefinementCtx,
  includePatchLimits: boolean
): void {
  const positions = new Set<number>();
  const identities = new Set<string>();
  const fileIds = new Set<string>();
  let fileCount = 0;
  let patchBytes = 0;

  value.repositories.forEach((repository, repositoryIndex) => {
    const identity = `${repository.repoOwner}/${repository.repoName}`.toLocaleLowerCase("en-US");
    if (positions.has(repository.position)) {
      ctx.addIssue({
        code: "custom",
        message: `Duplicate repository position: ${repository.position}`,
        path: ["repositories", repositoryIndex, "position"],
      });
    }
    if (identities.has(identity)) {
      ctx.addIssue({
        code: "custom",
        message: `Duplicate repository identity: ${repository.repoOwner}/${repository.repoName}`,
        path: ["repositories", repositoryIndex, "repoOwner"],
      });
    }
    positions.add(repository.position);
    identities.add(identity);

    const paths = new Set<string>();
    repository.files.forEach((file, fileIndex) => {
      fileCount += 1;
      if (fileIds.has(file.id)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate diff file id: ${file.id}`,
          path: ["repositories", repositoryIndex, "files", fileIndex, "id"],
        });
      }
      if (paths.has(file.path)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate diff file path: ${file.path}`,
          path: ["repositories", repositoryIndex, "files", fileIndex, "path"],
        });
      }
      fileIds.add(file.id);
      paths.add(file.path);
      if (includePatchLimits && file.patch !== undefined) {
        patchBytes += utf8Bytes(file.patch);
      }
    });
  });

  if (fileCount > SESSION_DIFF_MAX_FILES) {
    ctx.addIssue({
      code: "custom",
      message: `A bundle cannot include more than ${SESSION_DIFF_MAX_FILES.toLocaleString("en-US")} files`,
      path: ["repositories"],
    });
  }
  if (includePatchLimits && patchBytes > SESSION_DIFF_MAX_TOTAL_PATCH_BYTES) {
    ctx.addIssue({
      code: "custom",
      message: `A bundle cannot include more than ${SESSION_DIFF_MAX_TOTAL_PATCH_BYTES} patch bytes`,
      path: ["repositories"],
    });
  }
}

function validateEncodedBundle(value: unknown, ctx: z.RefinementCtx): void {
  if (utf8Bytes(JSON.stringify(value)) > SESSION_DIFF_MAX_BUNDLE_BYTES) {
    ctx.addIssue({
      code: "custom",
      message: `Encoded bundle exceeds ${SESSION_DIFF_MAX_BUNDLE_BYTES} UTF-8 bytes`,
      path: [],
    });
  }
}

const uploadShape = {
  version: z.literal(SESSION_DIFF_VERSION),
  triggerMessageId: nonEmptyIdSchema.nullable(),
  capturedAt: z.number().int().nonnegative(),
  repositories: z.array(sessionDiffRepositoryUploadSchema).min(1).max(MAX_SESSION_REPOSITORIES),
};

export const sessionDiffUploadSchema = z.object(uploadShape).superRefine((bundle, ctx) => {
  validateBundle(bundle, ctx, true);
  validateEncodedBundle(bundle, ctx);
});

export const storedSessionDiffBundleSchema = z
  .object({ revisionId: nonEmptyIdSchema, ...uploadShape })
  .superRefine((bundle, ctx) => {
    validateBundle(bundle, ctx, true);
    const { revisionId: _revisionId, ...storedValue } = bundle;
    validateEncodedBundle(storedValue, ctx);
  });

const manifestShape = {
  version: z.literal(SESSION_DIFF_VERSION),
  revisionId: nonEmptyIdSchema,
  triggerMessageId: nonEmptyIdSchema.nullable(),
  capturedAt: z.number().int().nonnegative(),
  repositories: z.array(sessionDiffRepositorySchema).min(1).max(MAX_SESSION_REPOSITORIES),
};

export const sessionDiffManifestSchema = z.object(manifestShape).superRefine((manifest, ctx) => {
  validateBundle(manifest, ctx, false);
});

export const sessionDiffStateSchema = z.object({
  version: z.literal(SESSION_DIFF_VERSION),
  current: sessionDiffManifestSchema.nullable(),
  lastError: z
    .object({
      message: errorSchema,
      occurredAt: z.number().int().nonnegative(),
    })
    .nullable(),
  unavailableReason: z.string().max(SESSION_DIFF_MAX_ERROR_LENGTH).nullable(),
});

export const sessionDiffFailureSchema = z.object({ error: errorSchema });

export type DiffRenderState = z.infer<typeof diffRenderStateSchema>;
export type DiffFileStatus = z.infer<typeof diffFileStatusSchema>;
export type SessionDiffBaselineRepository = z.infer<typeof sessionDiffBaselineRepositorySchema>;
export type SessionDiffFileUpload = z.infer<typeof sessionDiffFileUploadSchema>;
export type SessionDiffFile = z.infer<typeof sessionDiffFileSchema>;
export type SessionDiffRepositoryUpload = z.infer<typeof sessionDiffRepositoryUploadSchema>;
export type SessionDiffRepository = z.infer<typeof sessionDiffRepositorySchema>;
export type SessionDiffUpload = z.infer<typeof sessionDiffUploadSchema>;
export type StoredSessionDiffBundle = z.infer<typeof storedSessionDiffBundleSchema>;
export type SessionDiffManifest = z.infer<typeof sessionDiffManifestSchema>;
export type SessionDiffState = z.infer<typeof sessionDiffStateSchema>;
export type SessionDiffFailure = z.infer<typeof sessionDiffFailureSchema>;

/** Strip every patch body before a stored bundle crosses the browser-facing boundary. */
export function toSessionDiffManifest(bundle: StoredSessionDiffBundle): SessionDiffManifest {
  return sessionDiffManifestSchema.parse({
    ...bundle,
    repositories: bundle.repositories.map((repository) =>
      repository.status === "ready"
        ? {
            ...repository,
            files: repository.files.map(({ patch: _patch, ...file }) => file),
          }
        : repository
    ),
  });
}
