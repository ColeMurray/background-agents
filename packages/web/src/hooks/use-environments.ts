import { usePrerequisiteResource } from "@/hooks/use-prerequisite-resource";
import type { PrerequisiteStatus } from "@/lib/prerequisite-status";
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

  const {
    data,
    status: requestStatus,
    error,
  } = usePrerequisiteResource<ListEnvironmentsResponse>(session ? ENVIRONMENTS_KEY : null);
  const resourceStatus = status === "loading" ? "loading" : requestStatus;

  return {
    environments: data?.environments ?? [],
    status: resourceStatus,
    loading: resourceStatus === "loading",
    error,
  };
}
