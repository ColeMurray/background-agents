import useSWR from "swr";
import { useAuthSession } from "@/lib/auth-session";
import { usableFetchData } from "@/lib/swr-fetch-error";
import type {
  Environment,
  ListEnvironmentsResponse,
} from "@open-inspect/shared/types/environments";

export const ENVIRONMENTS_KEY = "/api/environments";

export interface EnvironmentListScope {
  /** Session catalog for a team: environments its sessions can use. */
  teamId?: string | null;
  /** Exact ownership filter; null selects workspace-owned environments. */
  ownerTeamId?: string | null;
}

export function environmentsKey({ teamId, ownerTeamId }: EnvironmentListScope = {}): string {
  const params = new URLSearchParams();
  if (teamId) params.set("teamId", teamId);
  if (ownerTeamId !== undefined) params.set("ownerTeamId", ownerTeamId ?? "null");
  const query = params.toString();
  return query ? `${ENVIRONMENTS_KEY}?${query}` : ENVIRONMENTS_KEY;
}

/** An empty scope lists every environment the viewer can read. */
export function useEnvironments(scope: EnvironmentListScope = {}): {
  environments: Environment[];
  loading: boolean;
  error: unknown;
} {
  const { data: session, status } = useAuthSession();

  const { data, isLoading, error } = useSWR<ListEnvironmentsResponse>(
    session ? environmentsKey(scope) : null
  );

  return {
    environments: usableFetchData(data, error)?.environments ?? [],
    // The fetch is gated on the auth session, so the list is still loading
    // while the session itself resolves — don't report an authoritative [].
    loading: status === "loading" || isLoading,
    error,
  };
}
