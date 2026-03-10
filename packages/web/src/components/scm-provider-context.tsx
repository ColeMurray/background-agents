"use client";

import { createContext, useContext } from "react";
import type { ScmProvider } from "@/lib/scm-provider";

const ScmProviderContext = createContext<ScmProvider>("github");

interface ScmProviderContextProviderProps {
  children: React.ReactNode;
  provider: ScmProvider;
}

export function ScmProviderContextProvider({
  children,
  provider,
}: ScmProviderContextProviderProps) {
  return <ScmProviderContext.Provider value={provider}>{children}</ScmProviderContext.Provider>;
}

export function useScmProvider(): ScmProvider {
  return useContext(ScmProviderContext);
}
