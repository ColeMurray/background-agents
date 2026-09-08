"use client";

import {
  SLACK_DENIAL_REASONS,
  type SlackDenialReason,
  type SlackNotifySuccessOutput,
  type SlackNotifyToolEnvelope,
  slackNotifyToolEnvelopeSchema,
} from "@open-inspect/shared";
import type { SandboxEvent } from "@/types/session";
import { formatSessionEventTime } from "@/lib/time";
import { getSafeExternalUrl } from "@/lib/urls";
import { APP_NAME } from "@/lib/site-config";
import { ChevronRightIcon, ErrorIcon, LinkIcon, SlackIcon } from "@/components/ui/icons";

type ToolCallEvent = Extract<SandboxEvent, { type: "tool_call" }>;

const DENIAL_COPY: Record<SlackDenialReason, { headline: string; hint?: string }> = {
  feature_unavailable: {
    headline: "Slack notifications are not configured for this deployment.",
  },
  feature_disabled: {
    headline: "Slack notifications are disabled for this repository.",
  },
  empty_message_after_sanitization: {
    headline: "Message was empty after sanitization, so nothing was posted.",
  },
  channel_not_found_or_forbidden: {
    headline: "Channel not found or bot is not in the channel.",
    hint: `Invite the ${APP_NAME} bot to the channel and try again.`,
  },
  rate_limited: {
    headline: "Slack rate-limited the request.",
    hint: "Slack will accept the next attempt after the retry window.",
  },
  slack_api_error: {
    headline: "Slack returned an unexpected error.",
  },
  invalid_input: {
    headline: "The notification arguments were invalid.",
  },
  bridge_error: {
    headline: "Couldn't reach the control plane to post the notification.",
  },
};

function parseEnvelope(output: string | undefined): SlackNotifyToolEnvelope | null {
  if (!output) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return null;
  }
  const result = slackNotifyToolEnvelopeSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

function getLegacyDenialReason(event: ToolCallEvent): SlackDenialReason | null {
  if (
    event.status === "error" &&
    typeof event.output === "string" &&
    (SLACK_DENIAL_REASONS as readonly string[]).includes(event.output)
  ) {
    return event.output as SlackDenialReason;
  }
  return null;
}

interface SlackNotifyEventProps {
  event: ToolCallEvent;
  isExpanded: boolean;
  onToggle: () => void;
  showTime?: boolean;
}

export function SlackNotifyEvent({
  event,
  isExpanded,
  onToggle,
  showTime = true,
}: SlackNotifyEventProps) {
  const envelope = parseEnvelope(event.output);
  const success = envelope?.ok === true ? envelope : null;
  const envelopeDenial = envelope?.ok === false ? envelope : null;
  const denial: SlackDenialReason | null = envelopeDenial?.reason ?? getLegacyDenialReason(event);
  const argsChannel = event.args?.channel;
  const channelInput =
    success?.channelInput ?? (typeof argsChannel === "string" ? argsChannel : undefined);
  const time = formatSessionEventTime(event.timestamp);

  let summaryLine: string;
  if (success) {
    summaryLine = `Posted to ${channelInput ?? "Slack"}`;
  } else if (denial) {
    summaryLine = `Slack notify failed${channelInput ? ` (${channelInput})` : ""}`;
  } else {
    summaryLine = `Slack notify${channelInput ? ` ${channelInput}` : ""}`;
  }

  return (
    <div className="py-0.5">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-1.5 text-sm text-left text-muted-foreground hover:text-foreground transition-colors"
      >
        <ChevronRightIcon
          className={`w-3.5 h-3.5 text-secondary-foreground transition-transform duration-200 ${
            isExpanded ? "rotate-90" : ""
          }`}
        />
        {denial ? (
          <ErrorIcon className="w-3.5 h-3.5 text-destructive" />
        ) : (
          <SlackIcon className="w-3.5 h-3.5 text-secondary-foreground" />
        )}
        <span className="truncate">slack-notify {summaryLine}</span>
        {showTime && (
          <span className="text-xs text-secondary-foreground flex-shrink-0 ml-auto">{time}</span>
        )}
      </button>

      {isExpanded && (
        <div className="mt-2 ml-5 p-3 bg-card border border-border-muted text-xs overflow-hidden">
          {success ? (
            <SlackNotifySuccessBody success={success} />
          ) : denial ? (
            <SlackNotifyDenialBody
              reason={denial}
              channelInput={channelInput}
              retryAfterSeconds={envelopeDenial?.retryAfterSeconds}
            />
          ) : (
            <span className="text-secondary-foreground">No details available</span>
          )}
        </div>
      )}
    </div>
  );
}

function SlackNotifySuccessBody({ success }: { success: SlackNotifySuccessOutput }) {
  const notes: string[] = [];
  if (success.truncated) notes.push("Message was truncated to fit Slack length limits.");
  if (success.strippedBroadcasts) notes.push("Broadcast mentions (@channel/@here) were stripped.");
  if (success.mentionsModified) notes.push("User mentions were rewritten per workspace policy.");

  const safePermalink = getSafeExternalUrl(success.permalink);

  return (
    <div className="space-y-2">
      <div>
        <div className="text-muted-foreground mb-1 font-medium">Channel</div>
        <div className="text-foreground">{success.channelInput}</div>
      </div>
      {safePermalink ? (
        <div>
          <div className="text-muted-foreground mb-1 font-medium">Slack message</div>
          <a
            href={safePermalink}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary inline-flex items-center gap-1 hover:underline"
          >
            <LinkIcon className="w-3 h-3" />
            View in Slack
          </a>
        </div>
      ) : null}
      {notes.length > 0 ? (
        <ul className="text-secondary-foreground list-disc pl-4 space-y-0.5">
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function SlackNotifyDenialBody({
  reason,
  channelInput,
  retryAfterSeconds,
}: {
  reason: SlackDenialReason;
  channelInput: string | undefined;
  retryAfterSeconds: number | undefined;
}) {
  const { headline, hint } = DENIAL_COPY[reason];
  const showRetryAfter =
    reason === "rate_limited" && typeof retryAfterSeconds === "number" && retryAfterSeconds > 0;
  return (
    <div className="space-y-1">
      <div className="text-foreground">{headline}</div>
      {hint ? <div className="text-secondary-foreground">{hint}</div> : null}
      {showRetryAfter ? (
        <div className="text-muted-foreground">
          Wait <span className="text-foreground">{retryAfterSeconds}s</span> before retrying.
        </div>
      ) : null}
      {channelInput ? (
        <div className="text-muted-foreground">
          Requested channel: <span className="text-foreground">{channelInput}</span>
        </div>
      ) : null}
    </div>
  );
}
