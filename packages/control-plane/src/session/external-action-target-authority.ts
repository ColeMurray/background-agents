import type { JsonValue } from "@earendil-works/chord";
import { parseRepositoryFullName } from "@open-inspect/shared/types/repositories";
import { slackPostGate, type SlackPostChannelBinding } from "../authorization/slack-post-gate";
import type { SessionEntry } from "../db/session-index";

interface ExternalActionTargetAuthorityOptions {
  getSession(sessionId: string): Promise<SessionEntry | null>;
  isRepositoryAuthorized(sessionId: string, repoOwner: string, repoName: string): Promise<boolean>;
  getChannelBinding(channelId: string): Promise<SlackPostChannelBinding | null>;
  hasLinearIssueContext(issueId: string): boolean;
}

export interface ExternalActionTargetRequest {
  readonly sessionId: string;
  readonly operationId: string;
  readonly provider: string;
  readonly action: string;
  readonly target: Record<string, JsonValue>;
}

/** Current D1/session authority for the exact external resource being targeted. */
export async function authorizeExternalActionTarget(
  options: ExternalActionTargetAuthorityOptions,
  request: ExternalActionTargetRequest
): Promise<boolean> {
  if (request.action === "comment" && request.provider === "github") {
    const owner = stringTarget(request.target, "owner");
    const repo = stringTarget(request.target, "repo");
    return owner !== null && repo !== null
      ? options.isRepositoryAuthorized(request.sessionId, owner, repo)
      : false;
  }

  if (request.action === "comment" && request.provider === "gitlab") {
    const project = stringTarget(request.target, "project");
    const repository = project === null ? null : parseRepositoryFullName(project);
    return repository !== null
      ? options.isRepositoryAuthorized(request.sessionId, repository.repoOwner, repository.repoName)
      : false;
  }

  if (request.action === "reply" && request.provider === "slack") {
    const channel = stringTarget(request.target, "channel");
    if (channel === null) return false;
    const [session, binding] = await Promise.all([
      options.getSession(request.sessionId),
      options.getChannelBinding(channel),
    ]);
    return slackPostGate(session, binding) === null;
  }

  if (request.action === "comment" && request.provider === "linear") {
    const issueId = stringTarget(request.target, "issueId");
    return issueId !== null && options.hasLinearIssueContext(issueId);
  }

  return false;
}

function stringTarget(target: Record<string, JsonValue>, key: string): string | null {
  const value = target[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}
