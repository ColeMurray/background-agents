import { useAuthSession } from "@/lib/auth-session";
import useSWR from "swr";
import type {
  AnalyticsDashboardResponse,
  AnalyticsDays,
} from "@open-inspect/shared/types/analytics";
import { ANALYTICS_REFRESH_INTERVAL_MS } from "@/lib/analytics";

export function useAnalyticsDashboard(days: AnalyticsDays) {
  const { data: session } = useAuthSession();
  const dashboard = useSWR<AnalyticsDashboardResponse>(
    session ? `/api/analytics/dashboard?days=${days}` : null,
    { refreshInterval: ANALYTICS_REFRESH_INTERVAL_MS }
  );

  return {
    summary: dashboard.data?.summary,
    timeseries: dashboard.data?.timeseries,
    repoBreakdown: dashboard.data?.breakdowns.repository,
    userBreakdown: dashboard.data?.breakdowns.user,
    pullRequests: dashboard.data?.pullRequests,
    loading: !dashboard.data && dashboard.isLoading,
    error: dashboard.error,
  };
}
