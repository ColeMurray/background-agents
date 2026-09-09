import { z } from "zod";
import { repositoriesInputSchema, repositoryInputSchema } from "./repositories";

/**
 * Sandbox-visible name, file/path, revision, and manifest limits are mirrored
 * by sandbox_runtime/managed_skills.py. Keep both runtimes aligned.
 */
export const MAX_SKILL_NAME_LENGTH = 64;
export const MAX_SKILL_DESCRIPTION_LENGTH = 1024;
export const MAX_SKILL_COMPATIBILITY_LENGTH = 500;
export const MAX_SKILL_FILES = 100;
export const MAX_SKILL_FILE_BYTES = 256 * 1024;
export const MAX_SKILL_REVISION_BYTES = 1024 * 1024;
export const MAX_SKILL_PATH_BYTES = 240;
export const MAX_SKILL_PATH_DEPTH = 10;
export const MAX_MANAGED_SKILL_MANIFEST_BYTES = 5 * 1024 * 1024;
export const SKILL_LIST_PAGE_SIZE = 100;

const utf8 = new TextEncoder();
const skillNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

const wellFormedString = z.string().refine(isWellFormedUnicode, "must contain valid Unicode");

export const skillNameSchema = z
  .string()
  .min(1)
  .max(MAX_SKILL_NAME_LENGTH)
  .regex(skillNamePattern, "must use lowercase letters, numbers, and single hyphens");

function isSafeSkillPath(path: string): boolean {
  const hasControlCharacter = Array.from(path).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
  if (!path || path.startsWith("/") || path.includes("\\") || hasControlCharacter) {
    return false;
  }
  const parts = path.split("/");
  return (
    parts.length <= MAX_SKILL_PATH_DEPTH &&
    parts.every((part) => part.length > 0 && part !== "." && part !== "..") &&
    utf8.encode(path).byteLength <= MAX_SKILL_PATH_BYTES
  );
}

export const skillFileInputSchema = z
  .strictObject({
    path: wellFormedString.refine(isSafeSkillPath, "must be a safe relative POSIX path"),
    content: wellFormedString.refine(
      (value) => utf8.encode(value).byteLength <= MAX_SKILL_FILE_BYTES,
      {
        message: `must be at most ${MAX_SKILL_FILE_BYTES} UTF-8 bytes`,
      }
    ),
    executable: z.boolean().optional().default(false),
  })
  .refine((file) => !file.executable || file.path.startsWith("scripts/"), {
    message: "only files under scripts/ may be executable",
    path: ["executable"],
  })
  .refine((file) => file.path !== "SKILL.md", {
    message: "SKILL.md is generated from the structured skill fields",
    path: ["path"],
  })
  .refine((file) => !file.path.startsWith("SKILL.md/"), {
    message: "SKILL.md cannot contain descendant paths",
    path: ["path"],
  });

export const skillMetadataSchema = z.record(
  wellFormedString.min(1).max(100),
  wellFormedString.max(500)
);

export const skillContentInputSchema = z
  .strictObject({
    description: wellFormedString.trim().min(1).max(MAX_SKILL_DESCRIPTION_LENGTH),
    body: wellFormedString,
    license: wellFormedString.trim().min(1).max(200).nullish(),
    compatibility: wellFormedString.trim().min(1).max(MAX_SKILL_COMPATIBILITY_LENGTH).nullish(),
    metadata: skillMetadataSchema.optional().default({}),
    files: z
      .array(skillFileInputSchema)
      .max(MAX_SKILL_FILES - 1)
      .optional()
      .default([]),
  })
  .superRefine((value, context) => {
    const seen = new Set<string>();
    let totalBytes = utf8.encode(value.body).byteLength + utf8.encode(value.description).byteLength;
    for (const file of value.files) {
      if (seen.has(file.path)) {
        context.addIssue({
          code: "custom",
          path: ["files"],
          message: `duplicate path: ${file.path}`,
        });
      }
      seen.add(file.path);
      totalBytes += utf8.encode(file.content).byteLength;
    }
    const paths = [...seen].sort();
    for (let index = 0; index < paths.length; index++) {
      for (let other = index + 1; other < paths.length; other++) {
        if (paths[other].startsWith(`${paths[index]}/`)) {
          context.addIssue({
            code: "custom",
            path: ["files"],
            message: `file path conflicts with directory path: ${paths[index]}`,
          });
        }
      }
    }
    if (totalBytes > MAX_SKILL_REVISION_BYTES) {
      context.addIssue({
        code: "custom",
        path: ["files"],
        message: `revision must be at most ${MAX_SKILL_REVISION_BYTES} UTF-8 bytes`,
      });
    }
  });

export const skillAssignmentInputSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("global") }),
  z.strictObject({ type: z.literal("repository"), repository: repositoryInputSchema }),
  z.strictObject({ type: z.literal("environment"), environmentId: z.string().trim().min(1) }),
]);

export const createSkillInputSchema = z.strictObject({
  name: skillNameSchema,
  content: skillContentInputSchema,
  assignments: z.array(skillAssignmentInputSchema).optional().default([]),
});

export const setSkillEnabledInputSchema = z.strictObject({ enabled: z.boolean() });

export const replaceSkillContentAndAssignmentsInputSchema = z.strictObject({
  content: skillContentInputSchema,
  assignments: z.array(skillAssignmentInputSchema),
});

export const skillFileSchema = z.strictObject({
  path: z.string(),
  content: z.string(),
  sha256: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  executable: z.boolean(),
});

/** Longest Git ref an import request may name (Git's own ref length ceiling). */
export const MAX_SKILL_IMPORT_REF_LENGTH = 255;
/** Longest repository subdirectory an import request may name, in UTF-8 bytes. */
export const MAX_SKILL_IMPORT_SUBDIRECTORY_BYTES = 240;
/** Deepest repository subdirectory an import request may name. */
export const MAX_SKILL_IMPORT_SUBDIRECTORY_DEPTH = 20;

function isSafeRepositorySubdirectory(path: string): boolean {
  if (path.startsWith("/") || path.endsWith("/") || path.includes("\\")) return false;
  const hasControlCharacter = Array.from(path).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
  if (hasControlCharacter) return false;
  const parts = path.split("/");
  return (
    parts.length <= MAX_SKILL_IMPORT_SUBDIRECTORY_DEPTH &&
    parts.every((part) => part.length > 0 && part !== "." && part !== "..") &&
    utf8.encode(path).byteLength <= MAX_SKILL_IMPORT_SUBDIRECTORY_BYTES
  );
}

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "must be a SHA-256 digest");
const commitShaSchema = z.string().regex(/^[0-9a-f]{7,64}$/, "must be a commit SHA");
const skillImportRefValueSchema = wellFormedString.trim().min(1).max(MAX_SKILL_IMPORT_REF_LENGTH);
const skillImportRefSchema = skillImportRefValueSchema.nullish();
const skillImportSubdirectoryValueSchema = wellFormedString
  .trim()
  .refine(isSafeRepositorySubdirectory, {
    message: "must be a safe relative POSIX path inside the repository",
  });

/** The resolved source of one import, without the time it was applied. */
export const skillImportSourceSchema = z.strictObject({
  provider: z.enum(["github", "gitlab", "bitbucket"]),
  repoOwner: z.string(),
  repoName: z.string(),
  /** The ref the importer asked for; null when the default branch was used. */
  requestedRef: skillImportRefValueSchema.nullable(),
  /** The ref actually read, after defaulting. */
  resolvedRef: skillImportRefValueSchema,
  /** Commit the content was read at — the pin for a moving ref. */
  commitSha: commitShaSchema,
  subdirectory: skillImportSubdirectoryValueSchema.nullable(),
  /**
   * Digest of the imported source bytes. Deliberately distinct from a
   * revision's `revisionSha256`: the stored `SKILL.md` is regenerated from the
   * mapped fields, so stored bytes differ from the bytes read upstream.
   */
  sourceSha256: sha256Schema,
});

/** A stored import, as reported on a skill. */
export const skillImportProvenanceSchema = skillImportSourceSchema.extend({
  importedAt: z.number(),
  /** Revision the import produced. */
  revisionId: z.string(),
});

export const skillAssignmentSchema = z.discriminatedUnion("type", [
  z.strictObject({ id: z.string(), type: z.literal("global") }),
  z.strictObject({
    id: z.string(),
    type: z.literal("repository"),
    repoOwner: z.string(),
    repoName: z.string(),
  }),
  z.strictObject({
    id: z.string(),
    type: z.literal("environment"),
    environmentId: z.string(),
    environmentName: z.string().optional(),
  }),
]);

export const skillSummarySchema = z.strictObject({
  id: z.string(),
  name: skillNameSchema,
  description: z.string(),
  enabled: z.boolean(),
  currentRevisionId: z.string(),
  revisionNumber: z.number().int().positive(),
  revisionSha256: z.string(),
  revisionCreatedBy: z.string(),
  creatorDisplayName: z.string().nullable(),
  lastEditorDisplayName: z.string().nullable(),
  revisionAuthorDisplayName: z.string().nullable(),
  assignments: z.array(skillAssignmentSchema),
  /**
   * Most recent recorded import, or null for an editor-authored skill. Survives
   * later hand edits so re-import always knows where the skill came from.
   */
  source: skillImportProvenanceSchema.nullable().optional().default(null),
  createdBy: z.string(),
  updatedBy: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const skillSchema = skillSummarySchema.extend({
  body: z.string(),
  license: z.string().nullable(),
  compatibility: z.string().nullable(),
  metadata: z.record(z.string(), z.string()),
  files: z.array(skillFileSchema),
});

export const listSkillsResponseSchema = z.discriminatedUnion("hasMore", [
  z.strictObject({
    skills: z.array(skillSummarySchema),
    hasMore: z.literal(false),
    nextCursor: z.null(),
  }),
  z.strictObject({
    skills: z.array(skillSummarySchema),
    hasMore: z.literal(true),
    nextCursor: skillNameSchema,
  }),
]);
export const skillResponseSchema = z.strictObject({ skill: skillSchema });

/**
 * Repository identity for an import. Normalizes like `repositoryInputSchema`
 * but drops `baseBranch`: an import reads at `ref`, and a second branch field
 * beside it would only be ambiguous.
 */
const importRepositoryInputSchema = z
  .strictObject({
    repoOwner: wellFormedString.trim().min(1),
    repoName: wellFormedString.trim().min(1),
  })
  .transform((repository) => ({
    repoOwner: repository.repoOwner.toLowerCase(),
    repoName: repository.repoName.toLowerCase(),
  }));

/**
 * Where imported skill content is read from. `ref` may name a branch, tag, or
 * commit; it is always resolved to a commit before anything is stored, so a
 * moving ref never becomes the recorded provenance.
 */
export const skillImportSourceInputSchema = z.strictObject({
  repository: importRepositoryInputSchema,
  ref: skillImportRefSchema,
  subdirectory: wellFormedString
    .trim()
    .nullish()
    .transform((value) => (value ? value.replace(/^\.?\/+|\/+$/g, "") : null))
    .refine((value) => value === null || isSafeRepositorySubdirectory(value), {
      message: "must be a safe relative POSIX path inside the repository",
    }),
});

/**
 * Findings that neither block the import nor survive into stored content.
 * Surfaced in the preview so an importer sees what the mapping did not carry.
 */
export const skillImportWarningSchema = z.strictObject({
  code: z.enum(["unmapped-frontmatter", "name-derived", "name-overridden"]),
  message: z.string(),
});

export const skillImportPreviewInputSchema = z.strictObject({
  source: skillImportSourceInputSchema,
  /** Overrides the canonical name derived from the source. */
  name: skillNameSchema.nullish(),
});

export const skillImportPreviewResponseSchema = z.strictObject({
  name: skillNameSchema,
  source: skillImportSourceSchema,
  description: z.string(),
  body: z.string(),
  license: z.string().nullable(),
  compatibility: z.string().nullable(),
  metadata: z.record(z.string(), z.string()),
  revisionSha256: z.string(),
  totalBytes: z.number().int().nonnegative(),
  files: z.array(
    z.strictObject({
      path: z.string(),
      content: z.string(),
      sizeBytes: z.number().int().nonnegative(),
      executable: z.boolean(),
    })
  ),
  warnings: z.array(skillImportWarningSchema),
  /**
   * False when another skill already holds this canonical name. On a
   * re-import the target skill's own name still counts as available.
   */
  nameAvailable: z.boolean(),
});

/**
 * Confirming an import re-reads the source and refuses to save unless it still
 * matches what the preview showed, so nothing is stored unreviewed.
 */
const importConfirmationSchema = z.strictObject({
  expectedCommitSha: commitShaSchema,
  expectedSourceSha256: sha256Schema,
  expectedRevisionSha256: sha256Schema,
});

export const importSkillInputSchema = importConfirmationSchema.extend({
  source: skillImportSourceInputSchema,
  name: skillNameSchema.nullish(),
  assignments: z.array(skillAssignmentInputSchema).optional().default([]),
});

/** Re-import reads the recorded repository and subdirectory; only the ref moves. */
export const reimportSkillPreviewInputSchema = z.strictObject({
  ref: skillImportRefSchema,
});

export const reimportSkillInputSchema = importConfirmationSchema.extend({
  ref: skillImportRefSchema,
});

export const reimportSkillResponseSchema = z.strictObject({
  skill: skillSchema,
  /** False when the source content was unchanged and no revision was added. */
  revisionCreated: z.boolean(),
});

export const createSkillProfileInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  skillIds: z.array(z.string().min(1)).default([]),
});
export const updateSkillProfileInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(200).optional(),
  skillIds: z.array(z.string().min(1)).optional(),
});
export const skillProfileSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  skillIds: z.array(z.string()),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export const listSkillProfilesResponseSchema = z.strictObject({
  profiles: z.array(skillProfileSchema),
});
export const skillProfileResponseSchema = z.strictObject({ profile: skillProfileSchema });

export const sessionSkillSelectionSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("all") }),
  z.strictObject({ mode: z.literal("none") }),
  z.strictObject({ mode: z.literal("profile"), profileId: z.string().min(1) }),
]);

export const skillResolutionPreviewInputSchema = z
  .strictObject({
    repoOwner: z.string().trim().min(1).optional(),
    repoName: z.string().trim().min(1).optional(),
    repositories: repositoriesInputSchema.optional(),
    environmentId: z.string().trim().min(1).optional(),
    selection: sessionSkillSelectionSchema.default({ mode: "all" }),
  })
  .superRefine((value, context) => {
    if (Boolean(value.repoOwner) !== Boolean(value.repoName)) {
      context.addIssue({
        code: "custom",
        path: ["repoName"],
        message: "repoOwner and repoName must be provided together",
      });
    }
    const targetModes = [
      Boolean(value.repoOwner && value.repoName),
      value.repositories !== undefined,
      value.environmentId !== undefined,
    ].filter(Boolean).length;
    if (targetModes > 1) {
      context.addIssue({
        code: "custom",
        path: ["repositories"],
        message: "select only one skill preview target",
      });
    }
  });

export const resolvedSkillSchema = z.strictObject({
  skillId: z.string(),
  revisionId: z.string(),
  name: skillNameSchema,
  description: z.string(),
  revisionNumber: z.number().int().positive(),
  revisionSha256: z.string(),
  totalBytes: z.number().int().nonnegative(),
  assignmentSources: z.array(skillAssignmentSchema),
});

export const skillResolutionPreviewResponseSchema = z.strictObject({
  skills: z.array(resolvedSkillSchema),
  totalBytes: z.number().int().nonnegative(),
  ignoredProfileSkillIds: z.array(z.string()),
});

const sessionSkillManifestSelectionSchema = z.union([
  z.strictObject({ mode: z.literal("all") }),
  z.strictObject({ mode: z.literal("none") }),
  z.strictObject({
    mode: z.literal("profile"),
    profileId: z.string(),
    profileName: z.string(),
  }),
]);

export const sessionSkillsViewSchema = z.strictObject({
  manifestSha256: z.string(),
  resolverVersion: z.literal(1),
  selection: sessionSkillManifestSelectionSchema,
  resolvedAt: z.number(),
  skills: z.array(resolvedSkillSchema),
});

/** Narrow sandbox DTO: installation files only; provenance stays on the user-facing view. */
/**
 * Per-file JSON framing is excluded from the manifest's content aggregate, so a
 * wide manifest can be accepted at resolution and still exceed the runtime's
 * per-response ceiling. Runtimes that ask for a page size receive `nextCursor`
 * and fetch the rest; runtimes that do not still receive the whole installation
 * with `nextCursor: null`, which is what keeps restored older sandboxes working.
 */
export const sandboxSkillInstallationSchema = z.object({
  schemaVersion: z.literal(1),
  manifestSha256: z.string(),
  skills: z.array(
    z.object({
      name: skillNameSchema,
      files: z.array(skillFileSchema),
    })
  ),
  nextCursor: z.string().nullable().default(null),
});

/** Bounds on the page size a sandbox may request from the installation endpoint. */
export const MAX_SANDBOX_SKILL_PAGE_SIZE = 200;

export type SkillFileInput = z.infer<typeof skillFileInputSchema>;
export type SkillContentInput = z.infer<typeof skillContentInputSchema>;
export type SkillAssignmentInput = z.infer<typeof skillAssignmentInputSchema>;
export type CreateSkillInput = z.infer<typeof createSkillInputSchema>;
export type SetSkillEnabledInput = z.infer<typeof setSkillEnabledInputSchema>;
export type ReplaceSkillContentAndAssignmentsInput = z.infer<
  typeof replaceSkillContentAndAssignmentsInputSchema
>;
export type SkillFile = z.infer<typeof skillFileSchema>;
export type SkillAssignment = z.infer<typeof skillAssignmentSchema>;
export type SkillSummary = z.infer<typeof skillSummarySchema>;
export type Skill = z.infer<typeof skillSchema>;
export type ListSkillsResponse = z.infer<typeof listSkillsResponseSchema>;
export type SkillProfile = z.infer<typeof skillProfileSchema>;
export type SessionSkillSelection = z.infer<typeof sessionSkillSelectionSchema>;
export type SessionSkillManifestSelection = z.infer<typeof sessionSkillManifestSelectionSchema>;
export type ResolvedSkill = z.infer<typeof resolvedSkillSchema>;
export type SessionSkillsView = z.infer<typeof sessionSkillsViewSchema>;
export type SandboxSkillInstallation = z.infer<typeof sandboxSkillInstallationSchema>;
export type SkillImportSourceInput = z.infer<typeof skillImportSourceInputSchema>;
export type SkillImportSource = z.infer<typeof skillImportSourceSchema>;
export type SkillImportProvenance = z.infer<typeof skillImportProvenanceSchema>;
export type SkillImportWarning = z.infer<typeof skillImportWarningSchema>;
export type SkillImportPreviewInput = z.infer<typeof skillImportPreviewInputSchema>;
export type SkillImportPreviewResponse = z.infer<typeof skillImportPreviewResponseSchema>;
export type ImportSkillInput = z.infer<typeof importSkillInputSchema>;
export type ReimportSkillPreviewInput = z.infer<typeof reimportSkillPreviewInputSchema>;
export type ReimportSkillInput = z.infer<typeof reimportSkillInputSchema>;
