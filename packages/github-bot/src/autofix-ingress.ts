import { z } from "zod";
import type { GitHubAutofixEnvelope } from "@open-inspect/shared";
import { containsBotMention } from "./github-mention";

const repositorySchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  owner: z.object({ login: z.string().min(1) }),
});

const pullRequestCommentPayloadSchema = z.object({
  action: z.literal("created"),
  issue: z.object({
    number: z.number().int().positive(),
    pull_request: z.object({}).passthrough(),
  }),
  comment: z.object({
    id: z.number().int().positive(),
    body: z.string(),
  }),
  repository: repositorySchema,
});

const pullRequestReviewPayloadSchema = z.object({
  action: z.literal("submitted"),
  review: z.object({
    id: z.number().int().positive(),
  }),
  pull_request: z.object({
    number: z.number().int().positive(),
  }),
  repository: repositorySchema,
});

interface AutofixIngressInput {
  event: string | undefined;
  payload: unknown;
  deliveryId: string;
  botUsername: string | undefined;
  receivedAt: Date;
}

function repositoryFrom(
  repository: z.infer<typeof repositorySchema>
): GitHubAutofixEnvelope["repository"] {
  return {
    id: String(repository.id),
    owner: repository.owner.login,
    name: repository.name,
  };
}

export function toAutofixEnvelope(input: AutofixIngressInput): GitHubAutofixEnvelope | null {
  switch (input.event) {
    case "issue_comment": {
      const parsed = pullRequestCommentPayloadSchema.safeParse(input.payload);
      if (!parsed.success || containsBotMention(parsed.data.comment.body, input.botUsername)) {
        return null;
      }

      return {
        version: 1,
        eventType: "issue_comment",
        action: "created",
        deliveryId: input.deliveryId,
        providerObject: {
          kind: "pr_comment",
          id: String(parsed.data.comment.id),
        },
        repository: repositoryFrom(parsed.data.repository),
        pullRequestNumber: parsed.data.issue.number,
        receivedAt: input.receivedAt.toISOString(),
      };
    }
    case "pull_request_review": {
      const parsed = pullRequestReviewPayloadSchema.safeParse(input.payload);
      if (!parsed.success) return null;

      return {
        version: 1,
        eventType: "pull_request_review",
        action: "submitted",
        deliveryId: input.deliveryId,
        providerObject: {
          kind: "review",
          id: String(parsed.data.review.id),
        },
        repository: repositoryFrom(parsed.data.repository),
        pullRequestNumber: parsed.data.pull_request.number,
        receivedAt: input.receivedAt.toISOString(),
      };
    }
    default:
      return null;
  }
}
