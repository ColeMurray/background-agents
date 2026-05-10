/**
 * Wire-contract types for the agent slack-notify endpoint and its renderers.
 *
 * Consumed by:
 * - control-plane (routes/slack-notify.ts) — produces these envelopes
 * - web (components/slack-notify-event.tsx) — parses tool_call output
 * - web settings UI — uses DEFAULT_MENTIONS_POLICY for form defaults
 *
 * The sandbox-side JS tool (packages/sandbox-runtime/.../tools/slack-notify.js)
 * cannot import from this package at runtime — it ships verbatim into the
 * sandbox image. Its REASON_GUIDANCE keys must stay symmetric with
 * SLACK_DENIAL_REASONS by hand.
 */

import type { SlackMentionsPolicy } from "../types/integrations";

/**
 * Reasons the slack-notify flow can fail.
 *
 * All but `bridge_error` are wire-contract codes: the control plane returns
 * them as HTTP `error` fields and the plugin propagates them. `bridge_error`
 * is plugin-only — it represents "the sandbox couldn't reach the control
 * plane at all" and therefore has no HTTP status (no request ever completed).
 */
export const SLACK_DENIAL_REASONS = [
  "feature_unavailable",
  "feature_disabled",
  "empty_message_after_sanitization",
  "channel_not_found_or_forbidden",
  "rate_limited",
  "slack_api_error",
  "invalid_input",
  "bridge_error",
] as const;

export type SlackDenialReason = (typeof SLACK_DENIAL_REASONS)[number];

/** Wire-contract subset: denial reasons that traverse HTTP. */
export type SlackWireDenialReason = Exclude<SlackDenialReason, "bridge_error">;

/**
 * HTTP status codes the control plane emits for each wire-contract denial
 * reason. `bridge_error` is omitted: by definition the plugin never received
 * an HTTP response when it produces that code.
 */
export const SLACK_DENIAL_STATUS: Record<SlackWireDenialReason, number> = {
  feature_unavailable: 503,
  feature_disabled: 403,
  empty_message_after_sanitization: 422,
  channel_not_found_or_forbidden: 404,
  rate_limited: 429,
  slack_api_error: 502,
  invalid_input: 400,
};

/** Successful tool_call output produced by the slack-notify route. */
export interface SlackNotifySuccessOutput {
  ok: true;
  channelInput: string;
  channelId: string;
  messageTs: string;
  permalink: string;
  truncated: boolean;
  strippedBroadcasts: boolean;
  mentionsModified: boolean;
}

/** HTTP failure body returned by the slack-notify endpoint to the sandbox. */
export interface SlackNotifyFailureBody {
  error: SlackWireDenialReason;
  message?: string;
  retryAfter?: number;
}

/**
 * Tool-output envelope the sandbox plugin returns from `execute()`.
 * The agent's tool_call event is the single source of truth for the
 * transcript; the renderer parses this envelope to show a rich row.
 *
 * `agentMessage` is human guidance for the model; `reason` is the stable
 * code the renderer keys on.
 */
export type SlackNotifyToolEnvelope =
  | SlackNotifySuccessOutput
  | {
      ok: false;
      reason: SlackDenialReason;
      agentMessage: string;
      retryAfter?: number;
    };

/** Default mention policy when no per-repo or global override is set. */
export const DEFAULT_MENTIONS_POLICY: SlackMentionsPolicy = "allow";
