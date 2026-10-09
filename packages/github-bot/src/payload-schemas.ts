import { z } from "zod";

const githubUserSchema = z.object({
  login: z.string(),
});

const githubSenderSchema = githubUserSchema.extend({
  id: z.number(),
  avatar_url: z.string(),
});

const repositorySchema = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
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

export const pullRequestOpenedPayloadSchema = z.object({
  action: z.literal("opened"),
  pull_request: pullRequestSchema.extend({ draft: z.boolean() }),
  repository: repositorySchema,
  sender: githubSenderSchema,
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

// Thread anchor fields only refine the prompt, so a missing or unexpected value
// degrades to "no anchor" instead of rejecting a mention the bot used to accept.
// GitHub sends `line: null` for outdated threads, so invalid values fall back to
// undefined rather than null to keep the two cases distinguishable.
const lineNumberSchema = z.number().int().positive().nullable().optional().catch(undefined);
const diffSideSchema = z.enum(["LEFT", "RIGHT"]).nullable().optional().catch(undefined);

export const reviewCommentPayloadSchema = z.object({
  action: z.literal("created"),
  pull_request: pullRequestSchema.omit({ body: true, user: true }),
  comment: z.object({
    id: z.number(),
    body: z.string(),
    path: z.string(),
    diff_hunk: z.string(),
    user: githubUserSchema,
    in_reply_to_id: z.number().int().positive().optional().catch(undefined),
    // Interpolated into shell commands in the prompt, so only a hex SHA is kept.
    commit_id: z
      .string()
      .regex(/^[0-9a-f]{40,64}$/)
      .optional()
      .catch(undefined),
    subject_type: z.string().optional().catch(undefined),
    line: lineNumberSchema,
    start_line: lineNumberSchema,
    side: diffSideSchema,
    start_side: diffSideSchema,
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

export type PullRequestOpenedPayload = z.infer<typeof pullRequestOpenedPayloadSchema>;
export type ReviewRequestedPayload = z.infer<typeof reviewRequestedPayloadSchema>;
export type IssueCommentPayload = z.infer<typeof issueCommentPayloadSchema>;
export type ReviewCommentPayload = z.infer<typeof reviewCommentPayloadSchema>;
export type WebhookSummaryPayload = z.infer<typeof webhookSummaryPayloadSchema>;
