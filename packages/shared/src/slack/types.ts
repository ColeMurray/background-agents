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

import { z } from "zod";
import type { SlackMentionsPolicy } from "../types/integrations";

/** Denial reasons across the slack-notify flow (control plane + plugin). */
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

export const slackDenialReasonSchema = z.enum(SLACK_DENIAL_REASONS);

export type SlackDenialReason = z.infer<typeof slackDenialReasonSchema>;

export type SlackWireDenialReason = Exclude<SlackDenialReason, "bridge_error">;

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
export const slackNotifySuccessOutputSchema = z.object({
  ok: z.literal(true),
  channelInput: z.string(),
  channelId: z.string(),
  messageTs: z.string(),
  permalink: z.string(),
  truncated: z.boolean(),
  strippedBroadcasts: z.boolean(),
  mentionsModified: z.boolean(),
});

export type SlackNotifySuccessOutput = z.infer<typeof slackNotifySuccessOutputSchema>;

/** HTTP failure body returned by the slack-notify endpoint to the sandbox. */
export interface SlackNotifyFailureBody {
  error: SlackWireDenialReason;
  message?: string;
  retryAfter?: number;
}

/** `agentMessage` is guidance for the model; `reason` is the code the renderer keys on. */
export const slackNotifyToolEnvelopeSchema = z.discriminatedUnion("ok", [
  slackNotifySuccessOutputSchema,
  z.object({
    ok: z.literal(false),
    reason: slackDenialReasonSchema,
    agentMessage: z.string(),
    retryAfter: z.number().optional(),
  }),
]);

export type SlackNotifyToolEnvelope = z.infer<typeof slackNotifyToolEnvelopeSchema>;

/** Default mention policy when no per-repo or global override is set. */
export const DEFAULT_MENTIONS_POLICY: SlackMentionsPolicy = "allow";
