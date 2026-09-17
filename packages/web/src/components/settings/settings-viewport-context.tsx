"use client";

import { createContext, useContext } from "react";

const SettingsViewportContext = createContext<boolean | undefined>(undefined);

export const SettingsViewportProvider = SettingsViewportContext.Provider;

export function useSettingsIsMobile(): boolean {
  const value = useContext(SettingsViewportContext);
  if (value === undefined) {
    throw new Error("useSettingsIsMobile must be used within SettingsViewportProvider");
  }
  return value;
}
