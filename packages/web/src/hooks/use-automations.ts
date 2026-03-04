import useSWR from "swr";
import { useSession } from "next-auth/react";
import type {
  Automation,
  ListAutomationsResponse,
  ListAutomationRunsResponse,
} from "@open-inspect/shared";

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
    runs: data?.runs ?? [],
    total: data?.total ?? 0,
    loading: isLoading,
    mutate,
  };
}
