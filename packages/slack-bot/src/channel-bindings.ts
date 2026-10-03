import { postMessage } from "@open-inspect/shared/slack";
import {
  channelBindingResponseSchema,
  type ChannelBindingResponse,
} from "@open-inspect/shared/types/team-channel-bindings";
import { controlPlaneFetch, ControlPlaneRequestError } from "./classifier/control-plane";
import { createLogger } from "./logger";
import { OUTBOUND_REQUEST_TIMEOUT_MS } from "./request-options";
import type { Env } from "./types";

const log = createLogger("channel-bindings");

export const CHANNEL_BINDING_UNAVAILABLE_MESSAGE =
  "I couldn't verify this channel's binding. Please try again.";

type ChannelBindingLookupResult =
  | { kind: "resolved"; binding: ChannelBindingResponse }
  | { kind: "rejected"; error: ControlPlaneRequestError }
  | { kind: "unavailable"; error: unknown };

/** Binding reads are authority: never cache them or fall back to workspace scope. */
export async function getChannelBinding(
  env: Env,
  channel: string,
  traceId?: string
): Promise<ChannelBindingResponse> {
  const path = `/channel-bindings/slack/${encodeURIComponent(channel)}`;
  const response = await controlPlaneFetch(env, path, traceId, OUTBOUND_REQUEST_TIMEOUT_MS);
  if (!response.ok) throw new ControlPlaneRequestError(path, response.status);
  return channelBindingResponseSchema.parse(await response.json());
}

export async function lookupChannelBinding(
  env: Env,
  channel: string,
  traceId?: string
): Promise<ChannelBindingLookupResult> {
  try {
    return { kind: "resolved", binding: await getChannelBinding(env, channel, traceId) };
  } catch (error) {
    if (error instanceof ControlPlaneRequestError && error.status === 404) {
      return { kind: "rejected", error };
    }
    return { kind: "unavailable", error };
  }
}

export async function resolveChannelBinding(
  env: Env,
  channel: string,
  threadTs: string,
  traceId?: string
): Promise<ChannelBindingResponse | null> {
  const result = await lookupChannelBinding(env, channel, traceId);
  if (result.kind === "resolved") return result.binding;
  const { error } = result;
  log.warn("control_plane.channel_binding", {
    trace_id: traceId,
    channel,
    http_status: error instanceof ControlPlaneRequestError ? error.status : undefined,
    error: error instanceof Error ? error : new Error(String(error)),
  });
  const message =
    result.kind === "rejected"
      ? "This channel is not bound. Ask a team lead or administrator to bind this channel to a team before starting a session."
      : CHANNEL_BINDING_UNAVAILABLE_MESSAGE;
  await postMessage(env.SLACK_BOT_TOKEN, channel, message, { thread_ts: threadTs });
  return null;
}
