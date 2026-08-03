import useSWR from "swr";
import { useAuthSession } from "@/lib/auth-session";
import type {
  Automation,
  ListAutomationsResponse,
  ListAutomationInvocationsResponse,
} from "@open-inspect/shared/types/automations";

export function useAutomations() {
  const { data: session } = useAuthSession();

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
  const { data: session } = useAuthSession();

  const { data, isLoading, mutate } = useSWR<{ automation: Automation }>(
    session && id ? `/api/automations/${id}` : null
  );

  return {
    automation: data?.automation ?? null,
    loading: isLoading,
    mutate,
  };
}

export function useAutomationInvocations(id: string | undefined, limit = 20, offset = 0) {
  const { data: session } = useAuthSession();

  const { data, isLoading, mutate } = useSWR<ListAutomationInvocationsResponse>(
    session && id ? `/api/automations/${id}/invocations?limit=${limit}&offset=${offset}` : null
  );

  return {
    invocations: data?.invocations ?? [],
    total: data?.total ?? 0,
    loading: isLoading,
    mutate,
  };
}
