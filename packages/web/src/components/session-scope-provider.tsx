"use client";

import {
  createContext,
  useContext,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import type { SessionVisibility } from "@open-inspect/shared/types/teams";
import type { SessionScopeRefreshError } from "@/lib/session-scope";
import { Button } from "./ui/button";

interface SessionScopeState {
  visibilitySelection: SessionVisibility | null;
  pending: boolean;
  visibilityFailure: {
    target: SessionVisibility;
    includedChildren: boolean;
    error: Error;
  } | null;
  refreshFailure: SessionScopeRefreshError | null;
}

const SessionScopeContext = createContext<{
  state: SessionScopeState;
  setState: Dispatch<SetStateAction<SessionScopeState>>;
  retryRefresh: () => Promise<void>;
} | null>(null);

/** All scope writes share pending/recovery state across responsive inspector remounts. */
export function SessionScopeProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionScopeState>({
    visibilitySelection: null,
    pending: false,
    visibilityFailure: null,
    refreshFailure: null,
  });

  async function retryRefresh() {
    if (!state.refreshFailure || state.pending) return;
    setState((current) => ({ ...current, pending: true }));
    try {
      await state.refreshFailure.retryRefresh();
      setState((current) => ({
        ...current,
        visibilitySelection: null,
        pending: false,
        refreshFailure: null,
      }));
    } catch {
      setState((current) => ({ ...current, pending: false }));
    }
  }

  return (
    <SessionScopeContext.Provider value={{ state, setState, retryRefresh }}>
      {children}
    </SessionScopeContext.Provider>
  );
}

export function useSessionScopeState() {
  const context = useContext(SessionScopeContext);
  if (!context) throw new Error("Session scope provider is missing");
  return context;
}

/** Refresh recovery is independent of the capabilities revoked by a failed snapshot fetch. */
export function SessionScopeRefreshNotice() {
  const { state, retryRefresh } = useSessionScopeState();
  if (!state.refreshFailure) return null;
  return (
    <div className="space-y-3">
      <p role="status" className="text-xs text-muted-foreground">
        {state.refreshFailure.message}
      </p>
      <Button
        size="xs"
        variant="outline"
        disabled={state.pending}
        onClick={() => void retryRefresh()}
      >
        Retry refresh
      </Button>
    </div>
  );
}
