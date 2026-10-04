import type {
  Env,
  PullRequestOpenedPayload,
  ReviewRequestedPayload,
  IssueCommentPayload,
  ReviewCommentPayload,
} from "./types";
import type { Logger } from "./logger";
import { buildCodeReviewPrompt, buildCommentActionPrompt } from "./prompts";
import { requestedReviewerPayloadSchema } from "./payload-schemas";
import { containsBotMention, stripBotMention } from "./github-mention";
import { startSession, type HandlerResult } from "./session-startup";
import { resolveThreadSuggestionTarget } from "./suggested-changes";

export type { HandlerResult } from "./session-startup";

export function isReviewRequestedForBot(payload: unknown, botUsername: string): boolean {
  const parsed = requestedReviewerPayloadSchema.safeParse(payload);
  if (!parsed.success) return false;
  return parsed.data.requested_reviewer?.login === botUsername;
}

export async function handleReviewRequested(
  env: Env,
  log: Logger,
  payload: ReviewRequestedPayload,
  traceId: string
): Promise<HandlerResult> {
  const { pull_request: pr, repository: repo, requested_reviewer, sender } = payload;

  if (requested_reviewer?.login !== env.GITHUB_BOT_USERNAME) {
    log.debug("handler.review_not_for_bot", {
      trace_id: traceId,
      requested_reviewer: requested_reviewer?.login,
    });
    return { outcome: "skipped", skip_reason: "review_not_for_bot" };
  }

  return startSession(env, log, traceId, {
    repository: repo,
    sender,
    pullNumber: pr.number,
    title: `GitHub: Review PR #${pr.number}`,
    action: "review",
    reactionPath: `issues/${pr.number}`,
    buildPrompt: (config) =>
      buildCodeReviewPrompt({
        owner: repo.owner.login,
        repo: repo.name,
        number: pr.number,
        title: pr.title,
        body: pr.body,
        author: pr.user.login,
        base: pr.base.ref,
        head: pr.head.ref,
        isPublic: !repo.private,
        codeReviewInstructions: config.codeReviewInstructions,
      }),
  });
}

export async function handlePullRequestOpened(
  env: Env,
  log: Logger,
  payload: PullRequestOpenedPayload,
  traceId: string
): Promise<HandlerResult> {
  const { pull_request: pr, repository: repo, sender } = payload;

  if (pr.draft) {
    log.debug("handler.draft_pr_skipped", { trace_id: traceId, pull_number: pr.number });
    return { outcome: "skipped", skip_reason: "draft_pr" };
  }

  return startSession(env, log, traceId, {
    repository: repo,
    sender,
    pullNumber: pr.number,
    title: `GitHub: Review PR #${pr.number}`,
    action: "auto_review",
    reactionPath: `issues/${pr.number}`,
    buildPrompt: (config) =>
      buildCodeReviewPrompt({
        owner: repo.owner.login,
        repo: repo.name,
        number: pr.number,
        title: pr.title,
        body: pr.body,
        author: pr.user.login,
        base: pr.base.ref,
        head: pr.head.ref,
        isPublic: !repo.private,
        codeReviewInstructions: config.codeReviewInstructions,
        isSelfReview: pr.user.login.toLowerCase() === env.GITHUB_BOT_USERNAME.toLowerCase(),
      }),
  });
}

export async function handleIssueComment(
  env: Env,
  log: Logger,
  payload: IssueCommentPayload,
  traceId: string
): Promise<HandlerResult> {
  const { issue, comment, repository: repo, sender } = payload;

  if (!issue.pull_request) {
    log.debug("handler.not_a_pr", { trace_id: traceId, issue_number: issue.number });
    return { outcome: "skipped", skip_reason: "not_a_pr" };
  }

  if (!containsBotMention(comment.body, env.GITHUB_BOT_USERNAME)) {
    log.debug("handler.no_mention", {
      trace_id: traceId,
      issue_number: issue.number,
      sender: sender.login,
    });
    return { outcome: "skipped", skip_reason: "no_mention" };
  }

  if (sender.login === env.GITHUB_BOT_USERNAME) {
    log.debug("handler.self_comment_ignored", { trace_id: traceId });
    return { outcome: "skipped", skip_reason: "self_comment" };
  }

  return startSession(env, log, traceId, {
    repository: repo,
    sender,
    pullNumber: issue.number,
    title: `GitHub: PR #${issue.number} comment`,
    action: "comment",
    reactionPath: `issues/comments/${comment.id}`,
    buildPrompt: (config) =>
      buildCommentActionPrompt({
        owner: repo.owner.login,
        repo: repo.name,
        number: issue.number,
        title: issue.title,
        commentBody: stripBotMention(comment.body, env.GITHUB_BOT_USERNAME),
        commenter: sender.login,
        isPublic: !repo.private,
        commentActionInstructions: config.commentActionInstructions,
      }),
  });
}

export async function handleReviewComment(
  env: Env,
  log: Logger,
  payload: ReviewCommentPayload,
  traceId: string
): Promise<HandlerResult> {
  const { pull_request: pr, comment, repository: repo, sender } = payload;

  if (!containsBotMention(comment.body, env.GITHUB_BOT_USERNAME)) {
    log.debug("handler.no_mention", {
      trace_id: traceId,
      pull_number: pr.number,
      sender: sender.login,
    });
    return { outcome: "skipped", skip_reason: "no_mention" };
  }

  if (sender.login === env.GITHUB_BOT_USERNAME) {
    log.debug("handler.self_comment_ignored", { trace_id: traceId });
    return { outcome: "skipped", skip_reason: "self_comment" };
  }

  return startSession(env, log, traceId, {
    repository: repo,
    sender,
    pullNumber: pr.number,
    title: `GitHub: PR #${pr.number} review comment`,
    action: "review_comment",
    reactionPath: `pulls/comments/${comment.id}`,
    buildPrompt: (config) =>
      buildCommentActionPrompt({
        owner: repo.owner.login,
        repo: repo.name,
        number: pr.number,
        title: pr.title,
        base: pr.base.ref,
        head: pr.head.ref,
        commentBody: stripBotMention(comment.body, env.GITHUB_BOT_USERNAME),
        commenter: sender.login,
        isPublic: !repo.private,
        reviewThread: {
          rootCommentId: comment.in_reply_to_id ?? comment.id,
          path: comment.path,
          diffHunk: comment.diff_hunk,
          suggestionTarget: resolveThreadSuggestionTarget(comment),
        },
        commentActionInstructions: config.commentActionInstructions,
      }),
  });
}
