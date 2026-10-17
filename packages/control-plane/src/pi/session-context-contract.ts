import { sandboxSkillInstallationSchema } from "@open-inspect/shared/types/skills";
import { z } from "zod";

const piRepositorySchema = z.object({
  repoOwner: z.string().min(1),
  repoName: z.string().min(1),
  position: z.number().int().nonnegative(),
  baseBranch: z.string().min(1).nullable(),
  commitSha: z.string().min(1),
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
      commitSha: z.string().trim().min(1).max(256).optional(),
      path: z.string().max(4_096).optional(),
      offset: z.number().int().nonnegative().optional(),
      limit: z.number().int().positive().max(500).optional(),
    }),
  }),
  z.object({
    tool: z.literal("repository_read"),
    arguments: z.object({
      repository: z.number().int().nonnegative().optional(),
      commitSha: z.string().trim().min(1).max(256).optional(),
      path: z.string().min(1).max(4_096),
      offset: z.number().int().nonnegative().optional(),
      limit: z.number().int().positive().max(50_000).optional(),
    }),
  }),
]);
