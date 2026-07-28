/**
 * Build Slack Block Kit messages for completion notifications.
 */

import type { AgentResponse, SlackCallbackContext } from "../types";
import { escapeMrkdwnText, type ManualPullRequestArtifactMetadata } from "@open-inspect/shared";

/**
 * Slack Block Kit block type (subset).
 */
interface SlackBlock {
  type: string;
  text?: { type: string; text: string };
  elements?: Array<{ type: string; text?: unknown; url?: string; action_id?: string }>;
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
const FALLBACK_TEXT_LIMIT = 150;
const ERROR_FOOTER_LIMIT = 200;

/**
 * Slack's hard cap on a section block's mrkdwn text. Responses longer than this
 * are split across consecutive section blocks rather than truncated, so a long
 * answer arrives whole instead of stopping mid-sentence.
 */
const SECTION_TEXT_MAX_CHARS = 3000;

/**
 * How many section blocks a response may occupy. Slack allows 50 blocks per
 * message; the rest of this builder contributes at most 4 (artifacts, tools,
 * footer, actions), so this leaves comfortable headroom. Beyond this the tail is
 * truncated and the View Session button is the way to read the whole thing.
 */
const MAX_RESPONSE_SECTIONS = 20;

const CODE_FENCE_RE = /^```/;

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

  // 1. Response text, split across as many section blocks as it needs
  const sections = splitIntoSlackSections(response.textContent);
  if (sections.length === 0) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: "_Agent completed._" } });
  } else {
    for (const section of sections) {
      blocks.push({ type: "section", text: { type: "mrkdwn", text: section } });
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

/**
 * Split agent prose into Slack section blocks, preferring paragraph boundaries.
 *
 * Long answers used to be cut at 2000 characters in a single block, which stopped
 * multi-part answers mid-sentence even though Slack accepts far more. Splitting
 * greedily on blank lines keeps headings with their prose; paragraphs that are
 * themselves oversized fall back to line boundaries, then to a hard slice.
 *
 * Fenced code blocks are closed at the end of a section and reopened at the start
 * of the next, so a split inside a fence doesn't leak monospace formatting across
 * the rest of the message.
 *
 * Returns [] for empty input so the caller can render its own placeholder.
 */
export function splitIntoSlackSections(
  text: string,
  maxChars: number = SECTION_TEXT_MAX_CHARS,
  maxSections: number = MAX_RESPONSE_SECTIONS
): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= maxChars) return [trimmed];

  const sections: string[] = [];
  let current = "";
  // Tracks whether `current` ends inside a fence, so the split can repair it.
  let fenceOpen = false;
  let fenceInfo = "";

  const flush = () => {
    if (!current) return;
    sections.push(fenceOpen ? `${current}\n\`\`\`` : current);
    current = "";
  };

  const appendChunk = (chunk: string) => {
    const reopen = fenceOpen ? `\`\`\`${fenceInfo}\n` : "";
    const candidate = current ? `${current}\n\n${chunk}` : `${reopen}${chunk}`;
    if (candidate.length <= maxChars) {
      current = candidate;
      return;
    }
    flush();
    const withReopen = `${fenceOpen ? `\`\`\`${fenceInfo}\n` : ""}${chunk}`;
    current = withReopen.length <= maxChars ? withReopen : withReopen.slice(0, maxChars);
  };

  // Track fence state per line so `fenceOpen` is accurate at every boundary.
  const consumeFences = (chunk: string) => {
    for (const line of chunk.split("\n")) {
      if (CODE_FENCE_RE.test(line.trimStart())) {
        if (fenceOpen) {
          fenceOpen = false;
          fenceInfo = "";
        } else {
          fenceOpen = true;
          fenceInfo = line.trimStart().slice(3).trim();
        }
      }
    }
  };

  for (const paragraph of trimmed.split(/\n{2,}/)) {
    if (paragraph.length <= maxChars) {
      appendChunk(paragraph);
      consumeFences(paragraph);
      continue;
    }
    // Oversized paragraph (long table, big code block): break on lines.
    let buffer = "";
    for (const line of paragraph.split("\n")) {
      const candidate = buffer ? `${buffer}\n${line}` : line;
      if (candidate.length <= maxChars) {
        buffer = candidate;
        continue;
      }
      if (buffer) {
        appendChunk(buffer);
        consumeFences(buffer);
      }
      // A single line longer than the cap has to be sliced.
      let rest = line;
      while (rest.length > maxChars) {
        appendChunk(rest.slice(0, maxChars));
        consumeFences(rest.slice(0, maxChars));
        rest = rest.slice(maxChars);
      }
      buffer = rest;
    }
    if (buffer) {
      appendChunk(buffer);
      consumeFences(buffer);
    }
  }
  flush();

  if (sections.length <= maxSections) return sections;
  const kept = sections.slice(0, maxSections);
  const last = kept[maxSections - 1];
  const marker = "\n\n_...truncated — open the session to read the rest_";
  kept[maxSections - 1] =
    last.length + marker.length <= maxChars
      ? last + marker
      : last.slice(0, maxChars - marker.length) + marker;
  return kept;
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
