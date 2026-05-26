/**
 * Build Slack Block Kit messages for completion notifications.
 */

import type { AgentResponse, SlackCallbackContext } from "../types";
import type { ManualPullRequestArtifactMetadata, PlanArtifact } from "@open-inspect/shared";

/**
 * Slack Block Kit block type (subset). `elements` allows the button-specific
 * fields (`value`, `style`) needed by plan approve/reject buttons.
 */
interface SlackBlock {
  type: string;
  text?: { type: string; text: string };
  elements?: Array<{
    type: string;
    text?: unknown;
    url?: string;
    action_id?: string;
    value?: string;
    style?: "primary" | "danger";
  }>;
}

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
const TRUNCATE_LIMIT = 2000;
const FALLBACK_TEXT_LIMIT = 150;
const ERROR_FOOTER_LIMIT = 200;

/**
 * Build Slack blocks for completion message.
 */
export function buildCompletionBlocks(
  sessionId: string,
  response: AgentResponse,
  context: SlackCallbackContext,
  webAppUrl: string
): SlackBlock[] {
  const blocks: SlackBlock[] = [];

  // 1. Response text (truncated)
  const text = truncateForSlack(response.textContent, TRUNCATE_LIMIT);
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: text || "_Agent completed._" },
  });

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
        text: `${emoji} ${status}  |  ${context.model}${effortSuffix}  |  ${context.repoFullName}`,
      },
    ],
  });

  const hasPrArtifact = response.artifacts.some((artifact) => artifact.type === "pr");
  const manualCreatePrUrl = getManualCreatePrUrl(response.artifacts);
  const actionElements: Array<{
    type: string;
    text: { type: string; text: string };
    url: string;
    action_id: string;
  }> = [
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
 * Get truncated text for Slack's fallback text field.
 */
export function getFallbackText(response: AgentResponse): string {
  return response.textContent.slice(0, FALLBACK_TEXT_LIMIT) || "Agent completed.";
}

function truncatePlanBody(content: string): string {
  return content.length > 2500 ? content.slice(0, 2500) + "\n\n_…truncated_" : content;
}

/**
 * Build Block Kit message for a plan that's awaiting approval. The user can
 * Approve (opens a modal to pick the build model) or Reject (opens a modal
 * for an optional reason), or jump to the web UI.
 *
 * The session id is carried in each button's `value` so the action handler
 * can route the click to the right control-plane plan endpoint.
 */
export function buildPlanAwaitingApprovalBlocks(
  sessionId: string,
  plan: PlanArtifact,
  webAppUrl: string
): SlackBlock[] {
  // Slack section blocks cap at 3000 chars; truncate well under that so the
  // surrounding header and footer always render.
  const planBody = truncatePlanBody(plan.content);

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:scroll: *Plan v${plan.version}* — awaiting your approval`,
      },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: planBody },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Approve" },
          action_id: "plan_approve",
          // value carries the session id so the action handler can route the
          // click to the right control-plane plan endpoint.
          value: sessionId,
          style: "primary",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Reject" },
          action_id: "plan_reject",
          value: sessionId,
          style: "danger",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "View plan in web" },
          url: `${webAppUrl}/session/${sessionId}#plan`,
          action_id: "view_session",
        },
      ],
    },
  ];
}

/**
 * Build Block Kit message for a plan that has reached a terminal verdict
 * (approved or rejected). Same shape as `buildPlanAwaitingApprovalBlocks`
 * minus the action buttons, with a verdict header and a context line. Used
 * to update the original plan message after the user submits the approve /
 * reject modal so the buttons no longer look clickable.
 */
export function buildPlanDecidedBlocks(params: {
  sessionId: string;
  plan: PlanArtifact;
  webAppUrl: string;
  verdict: "approved" | "rejected";
  /** Slack-formatted actor mention, e.g. `<@U123>`, or a plain string fallback. */
  actorMention: string;
  /** Approve only — human-readable build model label, e.g. "Claude Sonnet 4.5". */
  implementationModelLabel?: string;
  /** Reject only — optional reason provided by the rejecter. */
  reason?: string | null;
}): SlackBlock[] {
  const { sessionId, plan, webAppUrl, verdict, actorMention } = params;
  const icon = verdict === "approved" ? ":white_check_mark:" : ":x:";
  const verb = verdict === "approved" ? "approved" : "rejected";
  const planBody = truncatePlanBody(plan.content);

  const contextParts: string[] = [`${verb[0].toUpperCase() + verb.slice(1)} by ${actorMention}`];
  if (verdict === "approved" && params.implementationModelLabel) {
    contextParts.push(`building with ${params.implementationModelLabel}`);
  }
  if (verdict === "rejected" && params.reason && params.reason.trim().length > 0) {
    // Defense in depth: the reject modal caps the input at 500 chars, but
    // truncate again here so any future call site (API, programmatic reject)
    // can't push a long reason past Slack's 2000-char limit on `context`
    // block mrkdwn elements, which would silently fail `chat.update`.
    const trimmed = params.reason.trim();
    const truncated = trimmed.length > 500 ? trimmed.slice(0, 500) + "…" : trimmed;
    contextParts.push(`Reason: "${truncated}"`);
  }
  contextParts.push(`<${webAppUrl}/session/${sessionId}|View in web>`);

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${icon} *Plan v${plan.version}* — ${verb}`,
      },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: planBody },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: contextParts.join(" • "),
        },
      ],
    },
  ];
}

/**
 * Truncate text for Slack display with smart sentence breaks.
 */
function truncateForSlack(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const truncated = text.slice(0, maxLen);
  const lastPeriod = truncated.lastIndexOf(". ");
  if (lastPeriod > maxLen * 0.7) {
    return truncated.slice(0, lastPeriod + 1) + "\n\n_...truncated_";
  }
  return truncated + "...\n\n_...truncated_";
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
