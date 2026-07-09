import useSWR from "swr";
import { useSession } from "next-auth/react";
import type { Environment, ListEnvironmentsResponse } from "@open-inspect/shared";

export const ENVIRONMENTS_KEY = "/api/environments";

export function useEnvironments(): { environments: Environment[]; loading: boolean } {
  const { data: session } = useSession();

  const { data, isLoading } = useSWR<ListEnvironmentsResponse>(session ? ENVIRONMENTS_KEY : null);

  return {
    environments: data?.environments ?? [],
    loading: isLoading,
  };
}
