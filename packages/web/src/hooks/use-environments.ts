import useSWR from "swr";
import { getPrerequisiteStatus, type PrerequisiteStatus } from "@/lib/prerequisite-status";
import { useAuthSession } from "@/lib/auth-session";
import type {
  Environment,
  ListEnvironmentsResponse,
} from "@open-inspect/shared/types/environments";

export const ENVIRONMENTS_KEY = "/api/environments";

export function useEnvironments(): {
  environments: Environment[];
  loading: boolean;
  status: PrerequisiteStatus;
  error: unknown;
} {
  const { data: session, status } = useAuthSession();

  const { data, isLoading, error } = useSWR<ListEnvironmentsResponse>(
    session ? ENVIRONMENTS_KEY : null
  );

  return {
    environments: data?.environments ?? [],
    status: getPrerequisiteStatus(
      session ? data : undefined,
      status === "loading" || isLoading,
      error
    ),
    // The fetch is gated on the auth session, so the list is still loading
    // while the session itself resolves — don't report an authoritative [].
    loading: status === "loading" || isLoading,
    error,
  };
}
