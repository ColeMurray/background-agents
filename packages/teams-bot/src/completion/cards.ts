/**
 * Build plain-text completion messages for Teams.
 *
 * Uses markdown formatting that Teams renders inline — no Adaptive Card
 * borders, matching the natural feel of Slack's Block Kit completion messages.
 */

import type { AgentResponse } from "../types";
import type { ManualPullRequestArtifactMetadata } from "@open-inspect/shared";

const TRUNCATE_LIMIT = 2000;

/**
 * Build a plain-text completion message with markdown formatting.
 */
export function buildCompletionText(
  sessionId: string,
  response: AgentResponse,
  repoFullName: string,
  model: string,
  reasoningEffort: string | undefined,
  webAppUrl: string
): string {
  const parts: string[] = [];

  // 1. Response text (truncated)
  const text = truncateText(response.textContent, TRUNCATE_LIMIT);
  parts.push(text || "_Agent completed._");

  // 2. Artifacts (PRs, branches)
  if (response.artifacts.length > 0) {
    const artifactLines = response.artifacts
      .map((a) => (a.url ? `- [${a.label}](${a.url})` : `- ${a.label}`))
      .join("\n");
    parts.push(`**Created:**\n${artifactLines}`);
  }

  // 3. Status footer with session link
  const statusIcon = response.success ? "\u2705" : "\u26a0\ufe0f";
  const status = response.success ? "Done" : "Completed with issues";
  const effortSuffix = reasoningEffort ? ` (${reasoningEffort})` : "";
  const sessionUrl = `${webAppUrl}/session/${sessionId}`;

  const hasPrArtifact = response.artifacts.some((a) => a.type === "pr");
  const manualPrUrl = getManualCreatePrUrl(response.artifacts);
  const links = [`[View Session](${sessionUrl})`];
  if (!hasPrArtifact && manualPrUrl) {
    links.push(`[Create PR](${manualPrUrl})`);
  }

  parts.push(
    `${statusIcon} ${status} | ${model}${effortSuffix} | ${repoFullName}\n${links.join(" · ")}`
  );

  return parts.join("\n\n");
}

function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const truncated = text.slice(0, maxLen);
  const lastPeriod = truncated.lastIndexOf(". ");
  if (lastPeriod > maxLen * 0.7) {
    return truncated.slice(0, lastPeriod + 1) + "\n\n_...truncated_";
  }
  return truncated + "...\n\n_...truncated_";
}

function getManualCreatePrUrl(artifacts: AgentResponse["artifacts"]): string | null {
  const manualBranchArtifact = artifacts.find((artifact) => {
    if (artifact.type !== "branch") return false;
    if (!artifact.metadata || typeof artifact.metadata !== "object") return false;
    const metadata = artifact.metadata as Partial<ManualPullRequestArtifactMetadata> &
      Record<string, unknown>;
    if (metadata.mode === "manual_pr") return true;
    return metadata.mode == null && typeof metadata.createPrUrl === "string";
  });

  if (!manualBranchArtifact) return null;

  const metadataUrl = manualBranchArtifact.metadata?.createPrUrl;
  if (typeof metadataUrl === "string" && metadataUrl.length > 0) return metadataUrl;

  return manualBranchArtifact.url || null;
}
