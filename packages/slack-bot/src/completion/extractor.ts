/**
 * Extract and aggregate agent response from control-plane events.
 *
 * Delegates to the shared extractor from @open-inspect/shared, adapting
 * the package-specific Env bindings into the generic ExtractorDeps interface.
 */

import type { Env } from "../types";
import type { AgentResponse } from "@open-inspect/shared";
import {
  extractAgentResponse as sharedExtract,
  resolveOutboundCredential,
} from "@open-inspect/shared";
import { createLogger } from "../logger";

const log = createLogger("extractor");

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
      auth: resolveOutboundCredential("slack-bot", env),
      log,
    },
    sessionId,
    messageId,
    traceId
  );
}
