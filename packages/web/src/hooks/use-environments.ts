import useSWR from "swr";
import { useAuthSession } from "@/lib/auth-session";
import type {
  Environment,
  ListEnvironmentsResponse,
} from "@open-inspect/shared/types/environments";

export const ENVIRONMENTS_KEY = "/api/environments";

/** Omitted scope lists all readable environments; null filters workspace ownership. */
export function useEnvironments(teamId?: string | null): {
  environments: Environment[];
  loading: boolean;
  error: unknown;
} {
  const { data: session, status } = useAuthSession();

  const { data, isLoading, error } = useSWR<ListEnvironmentsResponse>(
    session
      ? teamId !== undefined
        ? `${ENVIRONMENTS_KEY}?teamId=${encodeURIComponent(teamId ?? "null")}`
        : ENVIRONMENTS_KEY
      : null
  );

  return {
    environments: data?.environments ?? [],
    // The fetch is gated on the auth session, so the list is still loading
    // while the session itself resolves — don't report an authoritative [].
    loading: status === "loading" || isLoading,
    error,
  };
}
