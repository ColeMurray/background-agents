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

/** Reasons the control plane can return for a denied or failed slack-notify request. */
export const SLACK_DENIAL_REASONS = [
  "feature_unavailable",
  "feature_disabled",
  "empty_message_after_sanitization",
  "channel_not_found_or_forbidden",
  "rate_limited",
  "slack_api_error",
  "invalid_input",
] as const;

export type SlackDenialReason = (typeof SLACK_DENIAL_REASONS)[number];

/** HTTP status codes the control plane emits for each denial reason. */
export const SLACK_DENIAL_STATUS: Record<SlackDenialReason, number> = {
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
  error: SlackDenialReason;
  message?: string;
  retryAfter?: number;
}

/** Default mention policy when no per-repo or global override is set. */
export const DEFAULT_MENTIONS_POLICY: SlackMentionsPolicy = "allow";
