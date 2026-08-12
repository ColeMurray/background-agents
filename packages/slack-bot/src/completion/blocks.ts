/**
 * Build Slack Block Kit messages for completion notifications.
 */

import type { AgentResponse } from "@open-inspect/shared/types/artifacts";
import type { SlackCallbackContext } from "@open-inspect/shared/types/session-api";
import type {
  SlackActionsBlock,
  SlackButtonElement,
  SlackContextBlock,
  SlackSectionBlock,
} from "../slack-blocks";
import { escapeMrkdwnText, splitIntoSlackSections } from "@open-inspect/shared/slack";
import type { ManualPullRequestArtifactMetadata } from "@open-inspect/shared/types/artifacts";

type CompletionSlackBlock = SlackSectionBlock | SlackContextBlock | SlackActionsBlock;

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
 * Build Slack blocks for completion message.
 */
export function buildCompletionBlocks(
  sessionId: string,
  response: AgentResponse,
  context: SlackCallbackContext,
  webAppUrl: string
): CompletionSlackBlock[] {
  const blocks: CompletionSlackBlock[] = [];

  // 1. Response text, split across as many section blocks as it needs
  const sections = splitIntoSlackSections(response.textContent);
  if (sections.length === 0) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: "_Agent completed._" } });
  } else {
    for (const section of sections) {
      blocks.push({ type: "section", expand: true, text: { type: "mrkdwn", text: section } });
    }
  }

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
    const metadata = artifact.metadata as Partial<ManualPullRequestArtifactMetadata> &
      Record<string, unknown>;
    if (metadata.mode === "manual_pr") {
      return true;
    }
    // Backward-compatible fallback for older artifacts that may not include mode.
    return metadata.mode == null && typeof metadata.createPrUrl === "string";
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
