import useSWR from "swr";
import { useAuthSession } from "@/lib/auth-session";
import { controlPlaneSlackChannelsResponseSchema } from "@open-inspect/shared/slack";
import { browserApiFetch, type BrowserApiPath } from "@/lib/browser-api-fetch";

/**
 * Fetch the workspace's Slack channels, using team binding admission when scoped to a team.
 * Listing failures withhold cached names. Callers may offer manual ID entry
 * for availability failures, but not for an authoritative access denial.
 *
 * Pass `enabled: false` to skip the request entirely — e.g. when there is no
 * Slack channel to resolve — without violating the rules of hooks.
 */
export function useSlackChannels(enabled = true, teamId?: string) {
  const { data: session } = useAuthSession();
  const key: BrowserApiPath = teamId
    ? `/api/teams/${encodeURIComponent(teamId)}/slack-channels`
    : "/api/integrations/slack/channels";

  const { data, error, isLoading, mutate } = useSWR(
    enabled && session?.user ? [key, session.user.id] : null,
    async () => {
      const response = await browserApiFetch(key);
      if (!response.ok) {
        throw Object.assign(new Error(`Failed to load Slack channels (${response.status})`), {
          status: response.status,
        });
      }
      return controlPlaneSlackChannelsResponseSchema.parse(await response.json());
    }
  );
  const listingError = error ? "fetch_failed" : data?.error;

  return {
    channels: enabled && session?.user && !listingError ? (data?.channels ?? []) : [],
    error: listingError,
    accessDenied: error?.status === 401 || error?.status === 403,
    loading: isLoading,
    mutate,
  };
}
