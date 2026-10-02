"use client";

import { isWorkspaceAdmin } from "@open-inspect/shared/rbac";
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useAuthSession } from "@/lib/auth-session";
import { isRetryableTeamError, useMeTeams } from "./use-teams";
import { useCurrentUserAuthorization } from "./use-current-user-authorization";

const ACTIVE_TEAM_STORAGE_KEY = "open-inspect-active-team";

function useActiveTeamState() {
  const { data: session } = useAuthSession();
  const memberships = useMeTeams();
  const {
    authorization,
    loading: authorizationLoading,
    error: authorizationError,
  } = useCurrentUserAuthorization();
  const [selection, setSelection] = useState<string | null>(null);
  const [hydratedUserId, setHydratedUserId] = useState<string | null>(null);
  const userId = session?.user.id ?? null;
  // Only the sidebar tolerates transient refresh failures with a successful snapshot.
  const membershipsError =
    memberships.hasData && isRetryableTeamError(memberships.error) ? undefined : memberships.error;
  const teams = membershipsError
    ? []
    : memberships.teams.filter((team) => team.archivedAt === null);
  const loading = memberships.loading || authorizationLoading || hydratedUserId !== userId;
  const error = membershipsError ?? (authorization ? undefined : authorizationError);
  const canListAllTeams = isWorkspaceAdmin(authorization?.role.key);

  useEffect(() => {
    let stored = "all-my-teams";
    try {
      stored = localStorage.getItem(ACTIVE_TEAM_STORAGE_KEY) ?? stored;
    } catch {
      // Storage is optional; the in-memory context remains usable.
    }
    setSelection(stored);
    setHydratedUserId(userId);
  }, [userId]);

  const activeSelection =
    !loading &&
    !error &&
    (selection === "workspace" ||
      selection === "all-my-teams" ||
      (selection === "all-teams" && canListAllTeams) ||
      teams.some((team) => team.id === selection))
      ? selection
      : "all-my-teams";
  const activeTeamId = teams.some((team) => team.id === activeSelection) ? activeSelection : null;
  const scope =
    teams.length === 0
      ? undefined
      : activeSelection === "workspace"
        ? ("workspace" as const)
        : activeSelection === "all-teams"
          ? ("all" as const)
          : undefined;

  useEffect(() => {
    if (loading || error) return;
    if (selection !== activeSelection) setSelection(activeSelection);
    try {
      localStorage.setItem(ACTIVE_TEAM_STORAGE_KEY, activeSelection ?? "all-my-teams");
    } catch {
      // Continue with the in-memory preference when storage is unavailable.
    }
  }, [activeSelection, loading, error, selection]);

  const setActiveTeam = useCallback(
    (value: string | null) => setSelection(value ?? "workspace"),
    []
  );

  return {
    activeTeamId,
    setActiveTeam,
    teams,
    scope,
    requireTeamOnCreate: membershipsError ? false : memberships.requireTeamOnCreate,
    loading,
    error,
  };
}

const ActiveTeamContext = createContext<ReturnType<typeof useActiveTeamState> | null>(null);

export function ActiveTeamProvider({ children }: { children: ReactNode }) {
  const value = useActiveTeamState();
  return createElement(ActiveTeamContext.Provider, { value }, children);
}

export function useActiveTeam() {
  const context = useContext(ActiveTeamContext);
  if (!context) throw new Error("useActiveTeam must be used within an ActiveTeamProvider");
  return context;
}
