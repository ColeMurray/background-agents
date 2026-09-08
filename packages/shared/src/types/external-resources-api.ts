import { z } from "zod";
import { sessionStatusSchema } from "./sessions";
import { sessionDiffStateSchema } from "./session-diffs";

const text = z.string().min(1);

export const externalListQuerySchema = z.strictObject({
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().nonnegative().optional(),
});
export type ExternalListQuery = z.infer<typeof externalListQuerySchema>;

export const externalKeysetListQuerySchema = z.strictObject({
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).optional(),
});
export type ExternalKeysetListQuery = z.infer<typeof externalKeysetListQuerySchema>;

export const externalDiffListQuerySchema = z.strictObject({
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().nonnegative().optional(),
  revisionId: z.string().min(1).optional(),
});
export type ExternalDiffListQuery = z.infer<typeof externalDiffListQuerySchema>;

function page<T extends z.ZodTypeAny>(key: string, item: T) {
  return z
    .object({
      [key]: z.array(item),
      hasMore: z.boolean(),
      continuationOffset: z.number().int().nonnegative().optional(),
    })
    .refine((value) => !value.hasMore || value.continuationOffset !== undefined, {
      message: "continuationOffset is required when hasMore is true",
      path: ["continuationOffset"],
    });
}

export const externalRepositorySchema = z.object({
  id: z.union([z.string(), z.number()]),
  owner: text,
  name: text,
  fullName: text,
  description: z.string().nullable(),
  private: z.boolean(),
  defaultBranch: text,
  archived: z.boolean(),
});
export const externalRepositoryListResponseSchema = page("repositories", externalRepositorySchema);

export const externalEnvironmentRepositorySchema = z.object({
  repoOwner: text,
  repoName: text,
  repoId: z.number().nullable(),
  baseBranch: text,
});
export const externalEnvironmentSchema = z.object({
  id: text,
  name: text,
  description: z.string().nullable(),
  prebuildEnabled: z.boolean(),
  repositories: z.array(externalEnvironmentRepositorySchema),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export const externalEnvironmentListResponseSchema = page(
  "environments",
  externalEnvironmentSchema
);
export const externalEnvironmentResponseSchema = z.object({
  environment: externalEnvironmentSchema,
});

export const externalModelSchema = z.object({
  id: text,
  name: text,
  description: z.string(),
  category: z.string(),
  default: z.boolean().optional(),
  reasoning: z.object({ efforts: z.array(z.string()), default: z.string().optional() }).nullable(),
});
export const externalModelListResponseSchema = z.object({ models: z.array(externalModelSchema) });

export const externalSkillSchema = z.object({
  id: text,
  name: text,
  description: z.string().optional(),
  enabled: z.boolean().optional(),
});
export const externalSkillProfileSchema = z.object({
  id: text,
  name: text,
  skillIds: z.array(z.string()),
});
export const externalSkillListResponseSchema = z.object({
  skills: z.array(externalSkillSchema),
  profiles: z.array(externalSkillProfileSchema),
  hasMore: z.boolean(),
  continuationOffset: z.number().int().nonnegative().optional(),
});

export const externalProviderAccountSchema = z.object({
  id: text,
  provider: text,
  displayName: text,
  status: text,
  isDefault: z.boolean(),
  unattendedMode: z.string().nullable(),
});
export const externalProviderAccountListResponseSchema = page(
  "accounts",
  externalProviderAccountSchema
);

export const externalMessageSchema = z.object({
  id: text,
  authorId: text,
  content: z.string(),
  source: z.string(),
  attachments: z.array(z.unknown()).nullable(),
  status: z.string(),
  createdAt: z.number(),
  startedAt: z.number().nullable(),
  completedAt: z.number().nullable(),
});
export const externalMessageListResponseSchema = z
  .object({
    messages: z.array(externalMessageSchema),
    cursor: z.string().min(1).optional(),
    hasMore: z.boolean(),
  })
  .refine((page) => !page.hasMore || page.cursor !== undefined, {
    message: "cursor is required when hasMore is true",
    path: ["cursor"],
  });

export const externalArtifactSchema = z.object({
  id: text,
  type: z.enum(["pr", "screenshot", "video", "preview", "branch"]),
  url: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export const externalArtifactListResponseSchema = z
  .object({
    artifacts: z.array(externalArtifactSchema),
    cursor: z.string().min(1).optional(),
    hasMore: z.boolean(),
  })
  .refine((page) => !page.hasMore || page.cursor !== undefined, {
    message: "cursor is required when hasMore is true",
    path: ["cursor"],
  });
export const externalArtifactContentResponseSchema = z.object({
  contentType: text,
  contentBase64: z.string(),
  offset: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  continuationOffset: z.number().int().nonnegative().optional(),
});

export const externalDiffStateResponseSchema = sessionDiffStateSchema
  .extend({
    hasMore: z.boolean(),
    continuationOffset: z.number().int().nonnegative().optional(),
    continuationRevisionId: z.string().min(1).optional(),
  })
  .refine(
    (page) =>
      !page.hasMore ||
      (page.continuationOffset !== undefined && page.continuationRevisionId !== undefined),
    {
      message: "continuationOffset and continuationRevisionId are required when hasMore is true",
      path: ["continuationOffset"],
    }
  );
export const externalDiffContentResponseSchema = z.object({
  content: z.string(),
  truncated: z.boolean(),
  hasMore: z.boolean(),
  continuationOffset: z.number().int().nonnegative().optional(),
});

export const externalPullRequestSchema = z
  .object({
    id: text,
    provider: text,
    repoOwner: text,
    repoName: text,
    number: z.number().int().positive(),
    url: z.string(),
    state: z.string(),
    headBranch: z.string().nullable(),
    baseBranch: z.string().nullable(),
  })
  .passthrough();
export const externalPullRequestListResponseSchema = z.object({
  pullRequests: z.array(externalPullRequestSchema),
  hasMore: z.boolean(),
  continuationOffset: z.number().int().nonnegative().optional(),
});

export const externalChildSessionSchema = z
  .object({
    id: text,
    title: z.string().nullable(),
    status: sessionStatusSchema,
    model: text,
    reasoningEffort: z.string().nullable(),
    repoOwner: z.string().nullable(),
    repoName: z.string().nullable(),
    environmentId: z.string().nullable(),
    parentSessionId: z.string().nullable(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .passthrough();
export const externalChildSessionListResponseSchema = z.object({
  children: z.array(externalChildSessionSchema),
  hasMore: z.boolean(),
  continuationOffset: z.number().int().nonnegative().optional(),
});

export const externalChildPromptRequestSchema = z.strictObject({
  content: text,
  clientRequestId: text.max(128),
});

export type ExternalRepository = z.infer<typeof externalRepositorySchema>;
export type ExternalEnvironment = z.infer<typeof externalEnvironmentSchema>;
export type ExternalModel = z.infer<typeof externalModelSchema>;
export type ExternalSkill = z.infer<typeof externalSkillSchema>;
export type ExternalProviderAccount = z.infer<typeof externalProviderAccountSchema>;
export type ExternalMessage = z.infer<typeof externalMessageSchema>;
export type ExternalArtifact = z.infer<typeof externalArtifactSchema>;
export type ExternalPullRequest = z.infer<typeof externalPullRequestSchema>;
export type ExternalChildSession = z.infer<typeof externalChildSessionSchema>;
