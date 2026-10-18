import { sandboxSkillInstallationSchema } from "@open-inspect/shared/types/skills";
import { z } from "zod";
import { FULL_GIT_OBJECT_ID_PATTERN } from "../source-control/git-object-id";

const fullGitObjectIdSchema = z
  .string()
  .regex(FULL_GIT_OBJECT_ID_PATTERN, "Expected a full Git object SHA");

const piRepositorySchema = z.object({
  repoOwner: z.string().min(1),
  repoName: z.string().min(1),
  position: z.number().int().nonnegative(),
  baseBranch: z.string().min(1).nullable(),
  commitSha: fullGitObjectIdSchema,
});

export const piRepositoryPinsSchema = z.array(
  piRepositorySchema.pick({
    repoOwner: true,
    repoName: true,
    position: true,
    commitSha: true,
  })
);

export const piSessionContextRequestSchema = z.object({
  repositoryPins: piRepositoryPinsSchema.optional(),
});

export const piSessionContextSchema = z.object({
  repositories: z.array(piRepositorySchema),
  skills: sandboxSkillInstallationSchema.nullable(),
});

export type PiSessionContext = z.infer<typeof piSessionContextSchema>;

export const piRepositoryToolRequestSchema = z.discriminatedUnion("tool", [
  z.object({
    tool: z.literal("repository_list"),
    arguments: z.object({
      repository: z.number().int().nonnegative().optional(),
      commitSha: fullGitObjectIdSchema.optional(),
      path: z.string().max(4_096).optional(),
      offset: z.number().int().nonnegative().optional(),
      limit: z.number().int().positive().max(500).optional(),
    }),
  }),
  z.object({
    tool: z.literal("repository_read"),
    arguments: z.object({
      repository: z.number().int().nonnegative().optional(),
      commitSha: fullGitObjectIdSchema.optional(),
      path: z.string().min(1).max(4_096),
      offset: z.number().int().nonnegative().optional(),
      limit: z.number().int().positive().max(50_000).optional(),
    }),
  }),
]);
