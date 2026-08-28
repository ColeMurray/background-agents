"use client";

import { createContext, useContext } from "react";
import { useIsMobile } from "@/hooks/use-media-query";

const SettingsViewportContext = createContext<boolean | null>(null);

export const SettingsViewportProvider = SettingsViewportContext.Provider;

export function useSettingsIsMobile(): boolean {
  const shellValue = useContext(SettingsViewportContext);
  const mediaQueryValue = useIsMobile();
  return shellValue ?? mediaQueryValue;
}
