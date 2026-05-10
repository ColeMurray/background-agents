"use client";

import {
  SLACK_DENIAL_REASONS,
  type SlackDenialReason,
  type SlackNotifySuccessOutput,
} from "@open-inspect/shared";
import type { SandboxEvent } from "@/types/session";
import { getSafeExternalUrl } from "@/lib/urls";
import { ChevronRightIcon, ErrorIcon, LinkIcon, SlackIcon } from "@/components/ui/icons";

type ToolCallEvent = Extract<SandboxEvent, { type: "tool_call" }>;

/** Defensive wire-shape: tolerates older events that omit non-essential fields. */
type ParsedSuccess = Pick<SlackNotifySuccessOutput, "ok" | "channelInput"> &
  Partial<Omit<SlackNotifySuccessOutput, "ok" | "channelInput">>;

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
    hint: "Invite the Open-Inspect bot to the channel and try again.",
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

function parseSuccess(output: string | undefined): ParsedSuccess | null {
  if (!output) return null;
  try {
    const parsed: unknown = JSON.parse(output);
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed as { ok?: unknown }).ok === true &&
      typeof (parsed as { channelInput?: unknown }).channelInput === "string"
    ) {
      return parsed as ParsedSuccess;
    }
  } catch {
    return null;
  }
  return null;
}

function parseDenialEnvelope(
  output: string
): { reason: SlackDenialReason; retryAfter?: number } | null {
  try {
    const parsed: unknown = JSON.parse(output);
    if (parsed && typeof parsed === "object" && (parsed as { ok?: unknown }).ok === false) {
      const reason = (parsed as { reason?: unknown }).reason;
      if (
        typeof reason === "string" &&
        (SLACK_DENIAL_REASONS as readonly string[]).includes(reason)
      ) {
        const retryAfterRaw = (parsed as { retryAfter?: unknown }).retryAfter;
        return {
          reason: reason as SlackDenialReason,
          retryAfter: typeof retryAfterRaw === "number" ? retryAfterRaw : undefined,
        };
      }
    }
  } catch {
    // not JSON
  }
  return null;
}

function getDenialReason(event: ToolCallEvent): SlackDenialReason | null {
  if (typeof event.output !== "string") return null;
  // Envelope shape: plugin returns `{ok:false, reason, ...}` as JSON.
  const fromEnvelope = parseDenialEnvelope(event.output);
  if (fromEnvelope) return fromEnvelope.reason;
  // Bare-code shape: pre-RPC, the control plane emitted a separate event
  // with status="error" and the reason code as `output`. Kept so historical
  // events still render correctly.
  if (
    event.status === "error" &&
    (SLACK_DENIAL_REASONS as readonly string[]).includes(event.output)
  ) {
    return event.output as SlackDenialReason;
  }
  return null;
}

function getRetryAfterSeconds(event: ToolCallEvent): number | undefined {
  if (typeof event.output !== "string") return undefined;
  return parseDenialEnvelope(event.output)?.retryAfter;
}

function getChannelInput(event: ToolCallEvent): string | undefined {
  const fromArgs = event.args?.channel;
  return typeof fromArgs === "string" ? fromArgs : undefined;
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
  const success = parseSuccess(event.output);
  const denial = success ? null : getDenialReason(event);
  const channelInput = success?.channelInput ?? getChannelInput(event);
  const time = new Date(event.timestamp * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

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
              retryAfterSeconds={getRetryAfterSeconds(event)}
            />
          ) : (
            <span className="text-secondary-foreground">No details available</span>
          )}
        </div>
      )}
    </div>
  );
}

function SlackNotifySuccessBody({ success }: { success: ParsedSuccess }) {
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
