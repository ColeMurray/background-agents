import { z } from "zod";
import { FULL_GIT_OBJECT_ID_PATTERN } from "../source-control/git-object-id";

const fullGitObjectIdSchema = z
  .string()
  .regex(FULL_GIT_OBJECT_ID_PATTERN, "Expected a full Git object SHA");
const repositoryRelativePathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.includes("\\") &&
      !path.includes("\0") &&
      path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
    "Expected a repository-relative POSIX path"
  );

export const PI_REPOSITORY_MAX_FILES = 1_000;
export const PI_REPOSITORY_MAX_FILE_BYTES = 256 * 1024;
export const PI_REPOSITORY_MAX_BYTES = 2 * 1024 * 1024;
export const PI_REPOSITORY_MATERIALIZATION_BATCH_FILES = 40;

const materializationTargetShape = {
  repository: z.number().int().nonnegative(),
  commitSha: fullGitObjectIdSchema,
};
export const piRepositoryMaterializationRequestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("manifest"), ...materializationTargetShape }),
  z.object({
    operation: z.literal("files"),
    ...materializationTargetShape,
    offset: z.number().int().nonnegative(),
  }),
]);

const piMaterializedFileMetadataSchema = z.object({
  path: repositoryRelativePathSchema,
  blobId: z.string().trim().min(1).max(256),
  mode: z.enum(["100644", "100755"]),
  sizeBytes: z.number().int().nonnegative().max(PI_REPOSITORY_MAX_FILE_BYTES).nullable(),
});
const piMaterializedFileSchema = piMaterializedFileMetadataSchema.extend({
  sizeBytes: z.number().int().nonnegative().max(PI_REPOSITORY_MAX_FILE_BYTES),
  contentBase64: z.string().max(350_000),
});
const piMaterializedRepositorySchema = z.object({
  position: z.number().int().nonnegative(),
  repoOwner: z.string().trim().min(1).max(300),
  repoName: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine((name) => !name.includes("/")),
  commitSha: fullGitObjectIdSchema,
  root: z.string(),
});

function validateMaterializationRoot(
  repository: z.infer<typeof piMaterializedRepositorySchema>,
  ctx: z.RefinementCtx
): void {
  if (repository.root !== `/workspace/repos/${repository.position}`) {
    ctx.addIssue({ code: "custom", path: ["repository", "root"], message: "Invalid root" });
  }
}

function validateUniquePaths(files: ReadonlyArray<{ path: string }>, ctx: z.RefinementCtx): void {
  const paths = new Set<string>();
  for (const [index, file] of files.entries()) {
    if (paths.has(file.path)) {
      ctx.addIssue({ code: "custom", path: ["files", index, "path"], message: "Duplicate path" });
    }
    paths.add(file.path);
  }
}

function validateMaterializedBytes(
  files: ReadonlyArray<{ sizeBytes: number; contentBase64: string }>,
  ctx: z.RefinementCtx
): void {
  let totalBytes = 0;
  for (const [index, file] of files.entries()) {
    try {
      const decodedBytes = atob(file.contentBase64).length;
      if (decodedBytes !== file.sizeBytes) {
        ctx.addIssue({
          code: "custom",
          path: ["files", index, "contentBase64"],
          message: "Decoded file size does not match sizeBytes",
        });
      }
      totalBytes += decodedBytes;
    } catch {
      ctx.addIssue({
        code: "custom",
        path: ["files", index, "contentBase64"],
        message: "Invalid base64 file content",
      });
    }
  }
  if (totalBytes > PI_REPOSITORY_MAX_BYTES) {
    ctx.addIssue({ code: "custom", path: ["files"], message: "Materialization is too large" });
  }
}

export const piRepositoryMaterializationManifestSchema = z
  .object({
    version: z.literal(1),
    repository: piMaterializedRepositorySchema,
    files: z.array(piMaterializedFileMetadataSchema).max(PI_REPOSITORY_MAX_FILES),
  })
  .superRefine((manifest, ctx) => {
    validateMaterializationRoot(manifest.repository, ctx);
    validateUniquePaths(manifest.files, ctx);
  });

export const piRepositoryMaterializationBatchSchema = z
  .object({
    version: z.literal(1),
    repository: piMaterializedRepositorySchema,
    offset: z.number().int().nonnegative(),
    nextOffset: z.number().int().nonnegative().nullable(),
    files: z.array(piMaterializedFileSchema).max(PI_REPOSITORY_MATERIALIZATION_BATCH_FILES),
  })
  .superRefine((batch, ctx) => {
    validateMaterializationRoot(batch.repository, ctx);
    validateUniquePaths(batch.files, ctx);
    validateMaterializedBytes(batch.files, ctx);
  });

export const piRepositoryMaterializationSchema = z
  .object({
    version: z.literal(1),
    repository: piMaterializedRepositorySchema,
    files: z.array(piMaterializedFileSchema).max(PI_REPOSITORY_MAX_FILES),
  })
  .superRefine((materialization, ctx) => {
    validateMaterializationRoot(materialization.repository, ctx);
    validateUniquePaths(materialization.files, ctx);
    validateMaterializedBytes(materialization.files, ctx);
  });

export type PiRepositoryMaterialization = z.infer<typeof piRepositoryMaterializationSchema>;
export type PiRepositoryMaterializationManifest = z.infer<
  typeof piRepositoryMaterializationManifestSchema
>;
export type PiRepositoryMaterializationBatch = z.infer<
  typeof piRepositoryMaterializationBatchSchema
>;
