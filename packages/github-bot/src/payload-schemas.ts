import { z } from "zod";

const githubUserSchema = z.object({
  login: z.string(),
});

const githubSenderSchema = githubUserSchema.extend({
  id: z.number(),
  avatar_url: z.string(),
});

const repositorySchema = z.object({
  id: z.number(),
  owner: githubUserSchema,
  name: z.string(),
  private: z.boolean(),
});

const webhookSummaryRepositorySchema = z.object({
  owner: githubUserSchema,
  name: z.string(),
});

const webhookNumberedObjectSchema = z.object({
  number: z.number().optional(),
});

const pullRequestSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string().nullable(),
  user: githubUserSchema,
  head: z.object({ ref: z.string(), sha: z.string() }),
  base: z.object({ ref: z.string() }),
});

export const pullRequestReviewTriggerActionSchema = z.enum([
  "opened",
  "reopened",
  "synchronize",
  "ready_for_review",
]);

export const pullRequestReviewTriggerPayloadSchema = z.object({
  action: pullRequestReviewTriggerActionSchema,
  pull_request: pullRequestSchema.extend({ draft: z.boolean() }),
  repository: repositorySchema,
  sender: githubSenderSchema,
  // Only GitHub's `synchronize` carries it: the head this push replaced. Used to close out that
  // commit's review status, which nothing else ever revisits.
  before: z.string().optional(),
});

export const reviewRequestedPayloadSchema = z.object({
  action: z.literal("review_requested"),
  pull_request: pullRequestSchema,
  requested_reviewer: githubUserSchema.nullable().optional(),
  repository: repositorySchema,
  sender: githubSenderSchema,
});

export const issueCommentPayloadSchema = z.object({
  action: z.literal("created"),
  issue: z.object({
    number: z.number(),
    title: z.string(),
    pull_request: z.object({ url: z.string() }).optional(),
  }),
  comment: z.object({
    id: z.number(),
    body: z.string(),
    user: githubUserSchema,
  }),
  repository: repositorySchema,
  sender: githubSenderSchema,
});

export const reviewCommentPayloadSchema = z.object({
  action: z.literal("created"),
  pull_request: pullRequestSchema.omit({ body: true, user: true }),
  comment: z.object({
    id: z.number(),
    body: z.string(),
    path: z.string(),
    diff_hunk: z.string(),
    user: githubUserSchema,
  }),
  repository: repositorySchema,
  sender: githubSenderSchema,
});

export const webhookSummaryPayloadSchema = z
  .object({
    action: z.unknown().optional(),
    repository: webhookSummaryRepositorySchema.nullable().optional(),
    sender: githubUserSchema.nullable().optional(),
    pull_request: webhookNumberedObjectSchema.nullable().optional(),
    issue: webhookNumberedObjectSchema.nullable().optional(),
  })
  .passthrough();

export const requestedReviewerPayloadSchema = z
  .object({
    requested_reviewer: githubUserSchema.nullable().optional(),
  })
  .passthrough();

export const webhookActionPayloadSchema = z
  .object({
    action: z.unknown().optional(),
  })
  .passthrough();

export type PullRequestReviewTriggerPayload = z.infer<typeof pullRequestReviewTriggerPayloadSchema>;
export type ReviewRequestedPayload = z.infer<typeof reviewRequestedPayloadSchema>;
export type IssueCommentPayload = z.infer<typeof issueCommentPayloadSchema>;
export type ReviewCommentPayload = z.infer<typeof reviewCommentPayloadSchema>;
export type WebhookSummaryPayload = z.infer<typeof webhookSummaryPayloadSchema>;
