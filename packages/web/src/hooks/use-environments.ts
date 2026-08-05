import useSWR from "swr";
import { useAuthSession } from "@/lib/auth-session";
import type {
  Environment,
  ListEnvironmentsResponse,
} from "@open-inspect/shared/types/environments";

export const ENVIRONMENTS_KEY = "/api/environments";

export function useEnvironments(): { environments: Environment[]; loading: boolean } {
  const { data: session, status } = useAuthSession();

  const { data, isLoading } = useSWR<ListEnvironmentsResponse>(session ? ENVIRONMENTS_KEY : null);

  return {
    environments: data?.environments ?? [],
    // The fetch is gated on the auth session, so the list is still loading
    // while the session itself resolves — don't report an authoritative [].
    loading: status === "loading" || isLoading,
  };
}
