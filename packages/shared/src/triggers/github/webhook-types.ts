import { z } from "zod";

import type { WebhookEventMap } from "@octokit/webhooks-types";

type GitHubWebhookEvent = Extract<keyof WebhookEventMap, string>;

type GitHubEventCatalogEntry<E extends GitHubWebhookEvent = GitHubWebhookEvent> = {
  event: E;
  action: Extract<WebhookEventMap[E], { action: string }>["action"];
  displayName: string;
  description: string;
  shortLabel: string;
};

export const GITHUB_WEBHOOK_EVENT_CATALOG = [
  {
    event: "pull_request",
    action: "opened",
    displayName: "PR Opened",
    description: "A pull request was opened",
    shortLabel: "PR opened",
  },
  {
    event: "pull_request",
    action: "synchronize",
    displayName: "PR Updated",
    description: "New commits pushed to a pull request",
    shortLabel: "PR updated",
  },
  {
    event: "pull_request",
    action: "closed",
    displayName: "PR Closed",
    description: "A pull request was closed or merged",
    shortLabel: "PR closed",
  },
  {
    event: "issue_comment",
    action: "created",
    displayName: "Issue Comment",
    description: "A comment was added to an issue or PR",
    shortLabel: "comment created",
  },
  {
    event: "pull_request_review_comment",
    action: "created",
    displayName: "Review Comment",
    description: "A review comment was added to a pull request",
    shortLabel: "review comment created",
  },
  {
    event: "check_suite",
    action: "completed",
    displayName: "Check Suite Completed",
    description: "A CI check suite finished running",
    shortLabel: "CI completed",
  },
  {
    event: "issues",
    action: "opened",
    displayName: "Issue Opened",
    description: "A new issue was opened",
    shortLabel: "issue opened",
  },
  {
    event: "issues",
    action: "labeled",
    displayName: "Issue Labeled",
    description: "A label was added to an issue",
    shortLabel: "issue labeled",
  },
] as const satisfies readonly GitHubEventCatalogEntry[];

// ─── Webhook payload schemas ──────────────────────────────────────────────────
//
// Each schema is the single source of truth for one supported event: it produces
// the static payload type via `z.infer` AND validates the raw webhook body at
// runtime via `safeParse` (see normalizer.ts). Only the fields consumed by the
// normalizer (trigger/concurrency keys, meta) and the context renderer are
// modeled; `z.object` strips unknown keys. Every field beyond the identity key
// is optional, so the inferred types stay loose enough for the defensive,
// optional-chained reads in normalizer.ts and context.ts. Fields GitHub models
// as `T | null` (an empty PR/issue `body`, an un-merged PR's `merged`) are
// `.nullable()` so a valid payload that sends `null` parses instead of being
// dropped as malformed.

const userSchema = z.object({
  login: z.string().optional(),
});

const repositorySchema = z.object({
  name: z.string().optional(),
  owner: userSchema.optional(),
});

const labelArraySchema = z.array(z.object({ name: z.string().optional() }));

const baseEventSchema = z.object({
  action: z.string(),
  repository: repositorySchema.optional(),
  sender: userSchema.optional(),
});

// Repo identity on a PR's head/base. `id` is the stable provider repo id used
// to detect cross-repository (fork) heads; GitHub sends head.repo as null when
// the fork was deleted.
const prRepoRefSchema = z.object({
  id: z.number().optional(),
  full_name: z.string().optional(),
});

const pullRequestObjectSchema = z.object({
  number: z.number(),
  title: z.string().optional(),
  body: z.string().nullable().optional(),
  state: z.string().optional(),
  draft: z.boolean().nullable().optional(),
  merged: z.boolean().nullable().optional(),
  html_url: z.string().optional(),
  updated_at: z.string().optional(),
  user: userSchema.optional(),
  labels: labelArraySchema.optional(),
  head: z
    .object({
      ref: z.string().optional(),
      sha: z.string().optional(),
      repo: prRepoRefSchema.nullable().optional(),
    })
    .optional(),
  base: z
    .object({ ref: z.string().optional(), repo: prRepoRefSchema.nullable().optional() })
    .optional(),
});

const commentSchema = z.object({
  id: z.number(),
  body: z.string().optional(),
  path: z.string().optional(),
  diff_hunk: z.string().optional(),
  user: userSchema.optional(),
});

const issueObjectSchema = z.object({
  number: z.number(),
  title: z.string().optional(),
  body: z.string().nullable().optional(),
  user: userSchema.optional(),
  pull_request: z.unknown().optional(),
  labels: labelArraySchema.optional(),
});

const checkSuiteObjectSchema = z.object({
  id: z.number(),
  conclusion: z.string().nullable().optional(),
  head_branch: z.string().nullable().optional(),
  head_sha: z.string().optional(),
  pull_requests: z.array(z.object({ number: z.number() })).optional(),
});

// GitHub always includes the event's primary object (a pull_request event always
// carries `pull_request`, an issue_comment always carries `issue` + `comment`,
// etc.), so each is required — a payload missing it is malformed and fails the
// parse rather than being papered over with a downstream null-check.
export const pullRequestEventSchema = baseEventSchema.extend({
  pull_request: pullRequestObjectSchema,
});

export const issueCommentEventSchema = baseEventSchema.extend({
  issue: issueObjectSchema,
  comment: commentSchema,
});

export const pullRequestReviewCommentEventSchema = baseEventSchema.extend({
  pull_request: pullRequestObjectSchema,
  comment: commentSchema,
});

export const checkSuiteEventSchema = baseEventSchema.extend({
  check_suite: checkSuiteObjectSchema,
});

export const issuesEventSchema = baseEventSchema.extend({
  issue: issueObjectSchema,
});

/** Fields shared by every supported event — all the context-free accessors need. */
export type GitHubEventBase = z.infer<typeof baseEventSchema>;
export type PullRequestPayload = z.infer<typeof pullRequestEventSchema>;
export type IssueCommentPayload = z.infer<typeof issueCommentEventSchema>;
export type PullRequestReviewCommentPayload = z.infer<typeof pullRequestReviewCommentEventSchema>;
export type CheckSuitePayload = z.infer<typeof checkSuiteEventSchema>;
export type IssuesPayload = z.infer<typeof issuesEventSchema>;
