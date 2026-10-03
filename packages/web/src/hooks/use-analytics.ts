import { useAuthSession } from "@/lib/auth-session";
import useSWR from "swr";
import type {
  AnalyticsDashboardResponse,
  AnalyticsDays,
  AnalyticsScope,
} from "@open-inspect/shared/types/analytics";
import { ANALYTICS_REFRESH_INTERVAL_MS } from "@/lib/analytics";

export function useAnalyticsDashboard(days: AnalyticsDays, scope: AnalyticsScope) {
  const { data: session } = useAuthSession();
  const { data, error, isLoading } = useSWR<AnalyticsDashboardResponse>(
    session ? `/api/analytics/dashboard?days=${days}&scope=${scope}` : null,
    // Keep the last snapshot on screen while another range or scope loads.
    { refreshInterval: ANALYTICS_REFRESH_INTERVAL_MS, keepPreviousData: true }
  );

  return {
    dashboard: data,
    loading: !data && isLoading,
    /** True while the snapshot on screen belongs to the previous range or scope. */
    stale: Boolean(data && (data.window.days !== days || data.window.scope !== scope)),
    error,
  };
}
