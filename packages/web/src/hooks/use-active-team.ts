"use client";

import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { parseSessionListTeamIds } from "@open-inspect/shared/session-list-query";
import { resolveWorkspaceTeamAccess } from "@open-inspect/shared/types/team-access";
import { useAuthSession } from "@/lib/auth-session";
import type { SessionInboxFilters } from "@/lib/session-inbox-api";
import { useCurrentUserAuthorization } from "./use-current-user-authorization";
import { isRetryableTeamError, useMeTeams } from "./use-teams";

const ACTIVE_TEAM_STORAGE_KEY = "open-inspect-active-team";

export function provisionalInboxFilters(
  selection: string | null,
  canListAllTeams: boolean
): SessionInboxFilters {
  if (!selection || selection === "all-my-teams") return {};
  if (selection === "workspace") return { scope: "workspace" };
  if (selection === "all-teams") return canListAllTeams ? { scope: "all" } : {};
  const teamIds = parseSessionListTeamIds(new URLSearchParams({ "teamIds[]": selection }));
  return teamIds ? { teamIds } : {};
}

function useActiveTeamState() {
  const { data: session } = useAuthSession();
  const { authorization } = useCurrentUserAuthorization();
  const memberships = useMeTeams();
  const [selection, setSelection] = useState<string | null>(null);
  const [hydratedUserId, setHydratedUserId] = useState<string | null>(null);
  const [denial, setDenial] = useState<{ userId: string | null; error: unknown } | null>(null);
  const userId = session?.user.id ?? null;
  // Retryable errors cannot restore a denied grant from SWR's retained membership data.
  const currentDenial =
    memberships.error && !isRetryableTeamError(memberships.error)
      ? { userId, error: memberships.error }
      : denial?.userId === userId && (memberships.error || !memberships.hasData)
        ? denial
        : null;
  if (denial?.userId !== currentDenial?.userId || denial?.error !== currentDenial?.error) {
    setDenial(currentDenial);
  }
  // Only the sidebar tolerates transient refresh failures with a successful snapshot.
  const error =
    currentDenial?.error ??
    (memberships.hasData && isRetryableTeamError(memberships.error)
      ? undefined
      : memberships.error);
  const teams = error ? [] : memberships.teams.filter((team) => team.archivedAt === null);
  const canListAllTeams = error ? false : memberships.canListAllTeams;
  const loading = memberships.loading || hydratedUserId !== userId;
  const provisionalFilters = useMemo(
    () =>
      memberships.loading && hydratedUserId === userId && authorization !== null
        ? provisionalInboxFilters(
            selection,
            resolveWorkspaceTeamAccess({
              roleKey: authorization.role.key,
              suspended: authorization.suspendedAt !== null,
            }).canListAllTeams
          )
        : null,
    [memberships.loading, hydratedUserId, userId, authorization, selection]
  );

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

  // Without an active team, lists stay unfiltered and the switcher is hidden, so aggregate
  // scopes reconcile to All my teams instead of staying stored.
  const activeSelection =
    !loading &&
    !error &&
    (selection === "all-my-teams" ||
      (teams.length > 0 &&
        (selection === "workspace" || (selection === "all-teams" && canListAllTeams))) ||
      teams.some((team) => team.id === selection))
      ? selection
      : "all-my-teams";
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
    provisionalFilters,
    canListAllTeams,
    requireTeamOnCreate: error ? false : memberships.requireTeamOnCreate,
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
