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
import { parseInlinePromptFlags } from "@open-inspect/shared/inline-prompt-flags";
import { startSession, type HandlerResult } from "./session-startup";

export type { HandlerResult } from "./session-startup";

/**
 * The logins a review request may name to reach this bot: the webhook App itself and, when a
 * second App submits the reviews, that App too — it is the one GitHub lists as the reviewer, so
 * the re-request button on a PR it reviewed names it, never the webhook App.
 */
export function reviewRequestLogins(
  env: Pick<Env, "GITHUB_BOT_USERNAME" | "GITHUB_REVIEWER_USERNAME">
): string[] {
  const reviewerLogin = env.GITHUB_REVIEWER_USERNAME?.trim();
  return reviewerLogin ? [env.GITHUB_BOT_USERNAME, reviewerLogin] : [env.GITHUB_BOT_USERNAME];
}

export function isReviewRequestedForBot(
  payload: unknown,
  acceptedLogins: readonly string[]
): boolean {
  const parsed = requestedReviewerPayloadSchema.safeParse(payload);
  if (!parsed.success) return false;
  const login = parsed.data.requested_reviewer?.login;
  return login !== undefined && acceptedLogins.includes(login);
}

/**
 * The code-review prompt fields that follow from the account whose token submits the review: the
 * reviewer App when one is configured, otherwise the webhook App. `isSelfReview` holds when GitHub
 * would refuse that account's approval as the PR's author; `hasReviewerApp` makes the prompt fetch
 * the reviewer App's token before the review POST.
 */
function reviewIdentityFields(
  env: Pick<Env, "GITHUB_BOT_USERNAME" | "GITHUB_REVIEWER_USERNAME">,
  author: string
): { isSelfReview: boolean; hasReviewerApp: boolean } {
  const reviewerLogin = env.GITHUB_REVIEWER_USERNAME?.trim();
  const submittingLogin = reviewerLogin || env.GITHUB_BOT_USERNAME;
  return {
    isSelfReview: author.toLowerCase() === submittingLogin.toLowerCase(),
    hasReviewerApp: Boolean(reviewerLogin),
  };
}

export async function handleReviewRequested(
  env: Env,
  log: Logger,
  payload: ReviewRequestedPayload,
  traceId: string
): Promise<HandlerResult> {
  const { pull_request: pr, repository: repo, requested_reviewer, sender } = payload;

  if (!requested_reviewer || !reviewRequestLogins(env).includes(requested_reviewer.login)) {
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
        ...reviewIdentityFields(env, pr.user.login),
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
        ...reviewIdentityFields(env, pr.user.login),
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

  const inlineFlags = parseInlinePromptFlags(
    stripBotMention(comment.body, env.GITHUB_BOT_USERNAME)
  );
  return startSession(env, log, traceId, {
    repository: repo,
    sender,
    pullNumber: issue.number,
    title: `GitHub: PR #${issue.number} comment`,
    action: "comment",
    reactionPath: `issues/comments/${comment.id}`,
    inlineFlags,
    buildPrompt: (config) =>
      buildCommentActionPrompt({
        owner: repo.owner.login,
        repo: repo.name,
        number: issue.number,
        title: issue.title,
        commentBody: inlineFlags.ok ? inlineFlags.text : "",
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

  const inlineFlags = parseInlinePromptFlags(
    stripBotMention(comment.body, env.GITHUB_BOT_USERNAME)
  );
  return startSession(env, log, traceId, {
    repository: repo,
    sender,
    pullNumber: pr.number,
    title: `GitHub: PR #${pr.number} review comment`,
    action: "review_comment",
    reactionPath: `pulls/comments/${comment.id}`,
    inlineFlags,
    buildPrompt: (config) =>
      buildCommentActionPrompt({
        owner: repo.owner.login,
        repo: repo.name,
        number: pr.number,
        title: pr.title,
        base: pr.base.ref,
        head: pr.head.ref,
        commentBody: inlineFlags.ok ? inlineFlags.text : "",
        commenter: sender.login,
        isPublic: !repo.private,
        filePath: comment.path,
        diffHunk: comment.diff_hunk,
        commentId: comment.id,
        commentActionInstructions: config.commentActionInstructions,
      }),
  });
}
