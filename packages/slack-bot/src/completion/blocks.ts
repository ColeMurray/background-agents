/**
 * Build Slack Block Kit messages for completion notifications.
 */

import type { AgentResponse } from "@open-inspect/shared/types/artifacts";
import type { SlackCallbackContext } from "@open-inspect/shared/types/session-api";
import type {
  SlackActionsBlock,
  SlackButtonElement,
  SlackContextBlock,
  SlackMarkdownBlock,
  SlackSectionBlock,
} from "../slack-blocks";
import {
  escapeMrkdwnText,
  MARKDOWN_BLOCK_MAX_CHARS,
  splitIntoSlackSections,
  stripBroadcastMentions,
} from "@open-inspect/shared/slack";

type CompletionSlackBlock =
  SlackMarkdownBlock | SlackSectionBlock | SlackContextBlock | SlackActionsBlock;

/**
 * Status emoji constants.
 */
const STATUS_EMOJI = {
  success: ":white_check_mark:",
  warning: ":warning:",
} as const;

/**
 * Truncation limits.
 */
const ERROR_FOOTER_LIMIT = 200;

/**
 * The agent's reply as the message's only `markdown` block. Agents write standard
 * Markdown, which a mrkdwn section shows as literal `##` and `**`; a `markdown`
 * block renders it as written.
 *
 * Every reply, whatever its length, gets the same treatment:
 * - It is cut to one fence-balanced block of at most MARKDOWN_BLOCK_MAX_CHARS that
 *   ends with a pointer to the session. More `markdown` blocks would not help, since
 *   they share that cap.
 * - Broadcast mentions are stripped, the same always-on strip `sanitizeAgentText`
 *   applies to agent notifications. Slack resolves `<!here>` and `<!channel>` inside
 *   a `markdown` block to real broadcasts (checked by posting one and reading back the
 *   stored rich_text), while a Markdown link such as `[x](!here)` stays a plain link.
 * - User mentions (`<@U…>`) pass through unchanged. The notify route's configurable
 *   user-mention policy lives in integration settings this path does not read, so it
 *   is out of scope here.
 */
function buildResponseBlock(text: string): SlackMarkdownBlock | SlackSectionBlock {
  const [body] = splitIntoSlackSections(stripBroadcastMentions(text), MARKDOWN_BLOCK_MAX_CHARS, 1);
  if (!body) return { type: "section", text: { type: "mrkdwn", text: "_Agent completed._" } };
  return { type: "markdown", text: body };
}

/**
 * Build Slack blocks for completion message.
 */
export function buildCompletionBlocks(
  sessionId: string,
  response: AgentResponse,
  context: SlackCallbackContext,
  webAppUrl: string
): CompletionSlackBlock[] {
  const blocks: CompletionSlackBlock[] = [];

  // 1. Response text
  blocks.push(buildResponseBlock(response.textContent));

  // 2. Artifacts (PRs, branches)
  if (response.artifacts.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Created:*\n" + response.artifacts.map((a) => `- <${a.url}|${a.label}>`).join("\n"),
      },
    });
  }

  // 3. Key tool actions
  const keyToolNames = ["Edit", "Write", "Bash"] as const;
  const keyTools = response.toolCalls
    .filter((t) => keyToolNames.includes(t.tool as (typeof keyToolNames)[number]))
    .slice(0, 5);
  if (keyTools.length > 0) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: keyTools.map((t) => t.summary).join(" | ") }],
    });
  }

  // 4. Status footer
  const emoji = response.success ? STATUS_EMOJI.success : STATUS_EMOJI.warning;
  const status = response.success
    ? "Done"
    : response.error
      ? `Failed: ${truncateError(response.error, ERROR_FOOTER_LIMIT)}`
      : "Completed with issues";
  const effortSuffix = context.reasoningEffort ? ` (${context.reasoningEffort})` : "";
  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        // The target label is raw user text for environment-launched sessions.
        text: `${emoji} ${status}  |  ${context.model}${effortSuffix}  |  ${escapeMrkdwnText(context.repoFullName)}`,
      },
    ],
  });

  const hasPrArtifact = response.artifacts.some((artifact) => artifact.type === "pr");
  const manualCreatePrUrl = getManualCreatePrUrl(response.artifacts);
  const actionElements: SlackButtonElement[] = [
    {
      type: "button",
      text: { type: "plain_text", text: "View Session" },
      url: `${webAppUrl}/session/${sessionId}`,
      action_id: "view_session",
    },
  ];

  if (!hasPrArtifact && manualCreatePrUrl) {
    actionElements.push({
      type: "button",
      text: { type: "plain_text", text: "Create PR" },
      url: manualCreatePrUrl,
      action_id: "create_pr",
    });
  }

  // 5. Action buttons
  blocks.push({
    type: "actions",
    elements: actionElements,
  });

  return blocks;
}

/**
 * Truncate an error string for Slack display, collapsing whitespace.
 */
export function truncateError(text: string, maxLen: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLen) return normalized;
  return normalized.slice(0, maxLen - 1) + "…";
}

function getManualCreatePrUrl(artifacts: AgentResponse["artifacts"]): string | null {
  const manualBranchArtifact = artifacts.find((artifact) => {
    if (artifact.type !== "branch") {
      return false;
    }
    if (!artifact.metadata || typeof artifact.metadata !== "object") {
      return false;
    }
    if (artifact.metadata.mode === "manual_pr") {
      return true;
    }
    // Backward-compatible fallback for older artifacts that may not include mode.
    return artifact.metadata.mode == null && typeof artifact.metadata.createPrUrl === "string";
  });

  if (!manualBranchArtifact) {
    return null;
  }

  const metadataUrl = manualBranchArtifact.metadata?.createPrUrl;
  if (typeof metadataUrl === "string" && metadataUrl.length > 0) {
    return metadataUrl;
  }

  return manualBranchArtifact.url || null;
}
