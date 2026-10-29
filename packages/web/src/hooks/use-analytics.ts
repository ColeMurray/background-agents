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
  const { data, error, isLoading, isValidating } = useSWR<AnalyticsDashboardResponse>(
    session ? `/api/analytics/dashboard?days=${days}&scope=${scope}` : null,
    // Keep the last snapshot on screen while another range or scope loads.
    { refreshInterval: ANALYTICS_REFRESH_INTERVAL_MS, keepPreviousData: true }
  );

  return {
    dashboard: data,
    loading: !data && isLoading,
    /**
     * The snapshot belongs to another range or scope: kept on screen while the
     * requested one loads, and still there if that request failed.
     */
    stale: Boolean(data && (data.window.days !== days || data.window.scope !== scope)),
    /** A request is in flight, whether a first load, a key change, a retry, or a refresh. */
    validating: isValidating,
    error,
  };
}
