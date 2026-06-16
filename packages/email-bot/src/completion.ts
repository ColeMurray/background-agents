import { extractAgentResponse as sharedExtract, type AgentResponse } from "@open-inspect/shared";
import type { Env } from "./types";
import { createLogger } from "./logger";

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
      log: createLogger("extractor", env.LOG_LEVEL),
    },
    sessionId,
    messageId,
    traceId
  );
}

export function buildEmailReply(params: {
  sessionId: string;
  webAppUrl: string;
  success: boolean;
  agentResponse: AgentResponse;
  error?: string;
}): string {
  const { sessionId, webAppUrl, success, agentResponse, error } = params;
  const text = agentResponse.textContent?.trim();

  if (text) {
    return `${text}\n\nSession: ${webAppUrl}/session/${sessionId}`;
  }

  if (!success) {
    return `The agent ran into an issue before producing a response.\n\n${error || "Unknown error"}\n\nSession: ${webAppUrl}/session/${sessionId}`;
  }

  return `The agent completed the request.\n\nSession: ${webAppUrl}/session/${sessionId}`;
}
