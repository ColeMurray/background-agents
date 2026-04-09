/**
 * Extract and aggregate agent response from control-plane events.
 *
 * Delegates to the shared extractor from @open-inspect/shared, adapting
 * the package-specific Env bindings into the generic ExtractorDeps interface.
 */

import type { Env } from "../types";
import type { AgentResponse } from "@open-inspect/shared";
import { extractAgentResponse as sharedExtract } from "@open-inspect/shared";
import { createLogger } from "../logger";

const log = createLogger("extractor");

/**
 * Tool names to include in summary display.
 * Re-exported from shared for backward compatibility.
 */
export { SUMMARY_TOOL_NAMES } from "@open-inspect/shared";

/**
 * Re-export shared helpers that other modules in this package may use.
 */
export {
  summarizeToolCall,
  getArtifactLabel,
  getArtifactLabelFromArtifact,
  toEventArtifactInfo,
  toArtifactType,
} from "@open-inspect/shared";

/**
 * Fetch events for a message and aggregate them into a response.
 *
 * Thin wrapper that maps the Slack-bot Env into the shared ExtractorDeps.
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
