"use client";

import { createContext, useContext } from "react";
import type { SessionBootstrap } from "@open-inspect/shared/types/server-messages";

const SessionBootstrapContext = createContext<SessionBootstrap | null>(null);

export function SessionBootstrapProvider({
  bootstrap,
  children,
}: {
  bootstrap: SessionBootstrap;
  children: React.ReactNode;
}) {
  return (
    <SessionBootstrapContext.Provider value={bootstrap}>
      {children}
    </SessionBootstrapContext.Provider>
  );
}

export function useSessionBootstrap(): SessionBootstrap {
  const bootstrap = useContext(SessionBootstrapContext);
  if (!bootstrap) throw new Error("Session bootstrap provider is missing");
  return bootstrap;
}
