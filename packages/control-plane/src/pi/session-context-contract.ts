import { sandboxSkillInstallationSchema } from "@open-inspect/shared/types/skills";
import { z } from "zod";
import { FULL_GIT_OBJECT_ID_PATTERN } from "../source-control/git-object-id";

const fullGitObjectIdSchema = z
  .string()
  .regex(FULL_GIT_OBJECT_ID_PATTERN, "Expected a full Git object SHA");

const piRepositoryIdentitySchema = z.object({
  repoOwner: z.string().min(1),
  repoName: z.string().min(1),
  position: z.number().int().nonnegative(),
  baseBranch: z.string().min(1).nullable(),
});

const piRepositorySchema = piRepositoryIdentitySchema.extend({
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

export const piSessionContextRequestSchema = z
  .object({
    mode: z.enum(["bootstrap", "pin"]).default("bootstrap"),
    repositoryPins: piRepositoryPinsSchema.optional(),
  })
  .superRefine((value, context) => {
    if (value.mode === "bootstrap" && value.repositoryPins !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Bootstrap context cannot include repository pins",
      });
    }
  });

/** One external publication this session may ask for. */
export const piExternalActionProviderSchema = z.object({
  provider: z.string().min(1).max(128),
  action: z.string().min(1).max(128),
  /** The stable tool name the model calls. */
  toolName: z.string().min(1).max(128),
});

export const piSessionContextSchema = z.object({
  repositories: z.array(
    piRepositoryIdentitySchema.extend({ commitSha: fullGitObjectIdSchema.optional() })
  ),
  skills: sandboxSkillInstallationSchema.nullable(),
  agentMessagingEnabled: z.boolean().default(false),
  /**
   * The publications this session may propose.
   *
   * A provider is listed only when the deployment named it and holds a
   * credential for it, so the model never sees a publication that could not
   * complete.
   */
  externalActions: z.array(piExternalActionProviderSchema).default([]),
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
