import { useSession } from "next-auth/react";
import useSWR from "swr";
import type {
  AnalyticsBreakdownResponse,
  AnalyticsDays,
  AnalyticsSummaryResponse,
  AnalyticsTimeseriesResponse,
} from "@open-inspect/shared";
import { ANALYTICS_REFRESH_INTERVAL_MS } from "@/lib/analytics";

export function useAnalyticsDashboard(days: AnalyticsDays) {
  const { data: session } = useSession();
  const refreshInterval = ANALYTICS_REFRESH_INTERVAL_MS;

  const summary = useSWR<AnalyticsSummaryResponse>(
    session ? `/api/analytics/summary?days=${days}` : null,
    { refreshInterval }
  );

  const timeseries = useSWR<AnalyticsTimeseriesResponse>(
    session ? `/api/analytics/timeseries?days=${days}` : null,
    { refreshInterval }
  );

  const repos = useSWR<AnalyticsBreakdownResponse>(
    session ? `/api/analytics/breakdown?days=${days}&by=repo` : null,
    { refreshInterval }
  );

  const users = useSWR<AnalyticsBreakdownResponse>(
    session ? `/api/analytics/breakdown?days=${days}&by=user` : null,
    { refreshInterval }
  );

  return {
    summary: summary.data,
    timeseries: timeseries.data,
    repoBreakdown: repos.data,
    userBreakdown: users.data,
    loading:
      (!summary.data && summary.isLoading) ||
      (!timeseries.data && timeseries.isLoading) ||
      (!repos.data && repos.isLoading) ||
      (!users.data && users.isLoading),
    error: summary.error ?? timeseries.error ?? repos.error ?? users.error,
  };
}
