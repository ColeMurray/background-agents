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
export const MAX_MANAGED_SKILLS_PER_SESSION = 20;
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

export const createSkillProfileInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  skillIds: z.array(z.string().min(1)).max(MAX_MANAGED_SKILLS_PER_SESSION).default([]),
});
export const updateSkillProfileInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(200).optional(),
  skillIds: z.array(z.string().min(1)).max(MAX_MANAGED_SKILLS_PER_SESSION).optional(),
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
export const sandboxSkillInstallationSchema = z.object({
  schemaVersion: z.literal(1),
  manifestSha256: z.string(),
  skills: z.array(
    z.object({
      name: skillNameSchema,
      files: z.array(skillFileSchema),
    })
  ),
});

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
