/**
 * Completion message formatting, kept within Discord's message length limit.
 */

import type { AgentResponse } from "@open-inspect/shared/types/artifacts";
import { MAX_MESSAGE_LENGTH } from "./discord-api";

/** Longest error shown inline; anything more belongs on the session page. */
const MAX_ERROR_LENGTH = 500;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

export function formatCompletion(params: {
  userId: string;
  success: boolean;
  error?: string;
  response: AgentResponse | null;
  sessionUrl: string;
}): string {
  const { userId, success, response } = params;
  const header = success ? `✅ <@${userId}> task complete` : `⚠️ <@${userId}> task failed`;
  const footer = `[View session](<${params.sessionUrl}>)`;

  const details: string[] = [];
  const pr = response?.artifacts.find((artifact) => artifact.type === "pr" && artifact.url);
  if (pr?.url) details.push(`**Pull request:** ${pr.url}`);
  if (!success && params.error) details.push(`**Error:** ${clip(params.error, MAX_ERROR_LENGTH)}`);

  const fixed = [header, ...details, footer].join("\n");
  const summary = response?.textContent.trim() ?? "";
  // Room left for the summary between the details and the footer.
  const budget = MAX_MESSAGE_LENGTH - fixed.length - 2;
  if (!summary || budget < 50) return fixed;

  return [header, ...details, "", clip(summary, budget), footer].join("\n");
}
