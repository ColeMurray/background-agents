import { z } from "zod";
import { githubAutofixAttemptLimitSchema } from "./integrations";

const repositorySchema = z.object({
  id: z.string().min(1),
  owner: z.string().min(1),
  name: z.string().min(1),
});

const envelopeBaseSchema = z.object({
  version: z.literal(1),
  deliveryId: z.string().min(1),
  repository: repositorySchema,
  pullRequestNumber: z.number().int().positive(),
  receivedAt: z.iso.datetime(),
});

const pullRequestCommentEnvelopeSchema = envelopeBaseSchema.extend({
  eventType: z.literal("issue_comment"),
  action: z.literal("created"),
  providerObject: z.object({
    kind: z.literal("pr_comment"),
    id: z.string().min(1),
  }),
});

const pullRequestReviewEnvelopeSchema = envelopeBaseSchema.extend({
  eventType: z.literal("pull_request_review"),
  action: z.literal("submitted"),
  providerObject: z.object({
    kind: z.literal("review"),
    id: z.string().min(1),
  }),
});

export const githubAutofixEnvelopeSchema = z.discriminatedUnion("eventType", [
  pullRequestCommentEnvelopeSchema,
  pullRequestReviewEnvelopeSchema,
]);

export type GitHubAutofixEnvelope = z.infer<typeof githubAutofixEnvelopeSchema>;

export const githubAutofixOriginSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("pr_comment"),
    authorType: z.literal("human"),
    feedbackUrl: z.url(),
  }),
  z.object({
    kind: z.literal("review"),
    authorType: z.enum(["human", "bot"]),
    feedbackUrl: z.url(),
  }),
]);

const enqueueFeedbackCommandSchema = z.object({
  type: z.literal("enqueue_feedback"),
  feedbackKey: z.string().min(1),
  pullRequest: z.object({
    repositoryId: z.string().min(1),
    number: z.number().int().positive(),
    artifactId: z.string().min(1),
  }),
  prompt: z.string().min(1),
  author: z.object({
    id: z.string().min(1),
    login: z.string().min(1),
  }),
  origin: githubAutofixOriginSchema,
  attemptLimit: githubAutofixAttemptLimitSchema,
});

const lookupFeedbackCommandSchema = z.object({
  type: z.literal("lookup_feedback"),
  feedbackKey: z.string().min(1),
});

export const githubAutofixSessionCommandSchema = z.discriminatedUnion("type", [
  enqueueFeedbackCommandSchema,
  lookupFeedbackCommandSchema,
]);

export const githubAutofixSessionResponseSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("enqueued"),
    messageId: z.string().min(1),
  }),
  z.object({
    kind: z.literal("duplicate"),
    messageId: z.string().min(1),
  }),
  z.object({
    kind: z.literal("rejected"),
    reason: z.enum(["session_closed", "queue_full", "attempt_limit"]),
  }),
  z.object({
    kind: z.literal("found"),
    messageId: z.string().min(1),
  }),
  z.object({
    kind: z.literal("not_found"),
  }),
]);

export type GitHubAutofixOrigin = z.infer<typeof githubAutofixOriginSchema>;
export type GitHubAutofixSessionCommand = z.infer<typeof githubAutofixSessionCommandSchema>;
export type GitHubAutofixSessionResponse = z.infer<typeof githubAutofixSessionResponseSchema>;
