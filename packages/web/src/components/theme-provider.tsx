"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { mutate } from "swr";
import { DEFAULT_THEME_ID, getAllThemeClasses, getThemeClass, type ThemeId } from "@/lib/theme";
import {
  USER_THEME_PREFERENCES_KEY,
  updateUserThemePreference,
} from "@/hooks/use-user-theme-preference";

interface ThemeContextValue {
  theme: ThemeId;
  setTheme: (theme: ThemeId) => Promise<void>;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

interface ThemeProviderProps {
  initialTheme: ThemeId;
  children: React.ReactNode;
}

function applyThemeToDocument(theme: ThemeId): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.classList.remove(...getAllThemeClasses());
  root.classList.add(getThemeClass(theme));
  root.classList.add("dark");
}

export function ThemeProvider({ initialTheme, children }: ThemeProviderProps) {
  const [theme, setThemeState] = useState<ThemeId>(initialTheme);

  useEffect(() => {
    applyThemeToDocument(theme);
  }, [theme]);

  const setTheme = useCallback(
    async (nextTheme: ThemeId) => {
      const previousTheme = theme;
      setThemeState(nextTheme);
      mutate(USER_THEME_PREFERENCES_KEY, { theme: nextTheme }, false);

      try {
        await updateUserThemePreference(nextTheme);
        await mutate(USER_THEME_PREFERENCES_KEY);
      } catch (error) {
        setThemeState(previousTheme);
        mutate(USER_THEME_PREFERENCES_KEY, { theme: previousTheme }, false);
        throw error;
      }
    },
    [theme]
  );

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      setTheme,
    }),
    [theme, setTheme]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    return {
      theme: DEFAULT_THEME_ID,
      setTheme: async () => {},
    };
  }
  return context;
}
