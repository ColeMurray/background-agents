import useSWR from "swr";
import { useSession } from "next-auth/react";
import type { SlackChannelListing } from "@open-inspect/shared";

interface SlackChannelsResponse {
  channels: SlackChannelListing[];
  error?: string;
}

/**
 * Fetch the workspace's Slack channels for the automation channel picker.
 * `error` is set (and `channels` empty) when listing is unavailable — no bot
 * token, missing scopes, or a Slack API failure — so callers can fall back to
 * manual channel-ID entry.
 *
 * Pass `enabled: false` to skip the request entirely — e.g. when there is no
 * Slack channel to resolve — without violating the rules of hooks.
 */
export function useSlackChannels(enabled = true) {
  const { data: session } = useSession();

  const { data, isLoading } = useSWR<SlackChannelsResponse>(
    enabled && session ? "/api/integrations/slack/channels" : null
  );

  return {
    channels: data?.channels ?? [],
    error: data?.error,
    loading: isLoading,
  };
}
