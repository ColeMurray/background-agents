"use client";

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
import { useMeTeams } from "./use-teams";
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
  const teams = memberships.teams.filter((team) => team.archivedAt === null);
  const loading = memberships.loading || authorizationLoading || hydratedUserId !== userId;
  const error = memberships.error ?? (authorization ? undefined : authorizationError);
  const canListAllTeams =
    authorization?.role.key === "owner" || authorization?.role.key === "administrator";

  useEffect(() => {
    let stored = "workspace";
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
    (selection === "all-my-teams" ||
      (selection === "all-teams" && canListAllTeams) ||
      teams.some((team) => team.id === selection))
      ? selection
      : "workspace";
  const activeTeamId = teams.some((team) => team.id === activeSelection) ? activeSelection : null;
  const scope =
    activeSelection === "workspace"
      ? ("workspace" as const)
      : activeSelection === "all-teams"
        ? ("all" as const)
        : undefined;

  useEffect(() => {
    if (loading || error) return;
    if (selection !== activeSelection) setSelection(activeSelection);
    try {
      localStorage.setItem(ACTIVE_TEAM_STORAGE_KEY, activeSelection ?? "workspace");
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
    requireTeamOnCreate: memberships.requireTeamOnCreate,
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
