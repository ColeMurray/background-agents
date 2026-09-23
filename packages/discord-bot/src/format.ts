/**
 * Completion message formatting, kept within Discord's message length limit.
 */

import type { AgentResponse } from "@open-inspect/shared/types/artifacts";
import { MAX_MESSAGE_LENGTH } from "./discord-api";

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
  if (!success && params.error) details.push(`**Error:** ${params.error}`);

  const fixed = [header, ...details, footer].join("\n");
  const summary = response?.textContent.trim() ?? "";
  // Room left for the summary between the details and the footer.
  const budget = MAX_MESSAGE_LENGTH - fixed.length - 2;
  if (!summary || budget < 50) return fixed;

  const clipped = summary.length > budget ? `${summary.slice(0, budget - 3)}...` : summary;
  return [header, ...details, "", clipped, footer].join("\n").slice(0, MAX_MESSAGE_LENGTH);
}
