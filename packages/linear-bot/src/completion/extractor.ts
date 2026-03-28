/**
 * Extract and aggregate agent response from control-plane events.
 *
 * Delegates to the shared extractor from @open-inspect/shared, adapting
 * the package-specific Env bindings into the generic ExtractorDeps interface.
 * The Linear-specific `formatAgentResponse` remains here.
 */

import type { Env } from "../types";
import type { AgentResponse } from "@open-inspect/shared";
import { extractAgentResponse as sharedExtract } from "@open-inspect/shared";
import { createLogger } from "../logger";

const log = createLogger("extractor");

/**
 * Fetch events for a message and aggregate them into a response.
 *
 * Thin wrapper that maps the Linear-bot Env into the shared ExtractorDeps.
 */
export async function extractAgentResponse(
  env: Env,
  sessionId: string,
  messageId: string,
  traceId?: string
): Promise<AgentResponse> {
  return sharedExtract(
    {
      fetcher: env.CONTROL_PLANE,
      internalSecret: env.INTERNAL_CALLBACK_SECRET,
      log,
    },
    sessionId,
    messageId,
    traceId
  );
}

/**
 * Format an AgentResponse into a markdown string for Linear AgentActivity.
 */
export function formatAgentResponse(agentResponse: AgentResponse): string {
  const parts: string[] = [];

  // PR / artifacts
  const prArtifact = agentResponse.artifacts.find((a) => a.type === "pr" && a.url);
  if (prArtifact) {
    parts.push(`**Pull request opened:** ${prArtifact.url}`);
  }

  // Files edited/created
  const fileEdits = agentResponse.toolCalls.filter((t) => t.tool === "Edit" || t.tool === "Write");
  if (fileEdits.length > 0) {
    parts.push(`**Files changed (${fileEdits.length}):**`);
    for (const edit of fileEdits.slice(0, 10)) {
      parts.push(`- ${edit.summary}`);
    }
    if (fileEdits.length > 10) parts.push(`- ... and ${fileEdits.length - 10} more`);
  }

  // Summary text (truncated)
  if (agentResponse.textContent) {
    const summary =
      agentResponse.textContent.length > 500
        ? agentResponse.textContent.slice(0, 500) + "..."
        : agentResponse.textContent;
    parts.push(`\n${summary}`);
  }

  return parts.join("\n");
}
