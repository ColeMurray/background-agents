import useSWR from "swr";
import { useSession } from "next-auth/react";
import type {
  Automation,
  AutomationRun,
  AutomationRunGroup,
  ListAutomationsResponse,
  ListAutomationRunsResponse,
} from "@open-inspect/shared";

const EMPTY_RUNS: AutomationRun[] = [];
const EMPTY_GROUPS: AutomationRunGroup[] = [];

export function useAutomations() {
  const { data: session } = useSession();

  const { data, isLoading, mutate } = useSWR<ListAutomationsResponse>(
    session ? "/api/automations" : null
  );

  return {
    automations: data?.automations ?? [],
    total: data?.total ?? 0,
    loading: isLoading,
    mutate,
  };
}

export function useAutomation(id: string | undefined) {
  const { data: session } = useSession();

  const { data, isLoading, mutate } = useSWR<{ automation: Automation }>(
    session && id ? `/api/automations/${id}` : null
  );

  return {
    automation: data?.automation ?? null,
    loading: isLoading,
    mutate,
  };
}

export function useAutomationRuns(id: string | undefined, limit = 20, offset = 0) {
  const { data: session } = useSession();

  const { data, isLoading, mutate } = useSWR<ListAutomationRunsResponse>(
    session && id ? `/api/automations/${id}/runs?limit=${limit}&offset=${offset}` : null
  );

  return {
    runs: data?.runs ?? EMPTY_RUNS,
    groups: data?.groups ?? EMPTY_GROUPS,
    total: data?.total ?? 0,
    loading: isLoading,
    mutate,
  };
}
