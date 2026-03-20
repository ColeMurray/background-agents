import { useState, useEffect, useCallback } from "react";

export type ColorSchemeMode = "light" | "dark" | "system";

export interface SyntaxHighlightThemeDefinition {
  id: string;
  label: string;
  colorScheme: "light" | "dark";
  cssPath: string;
}

/**
 * Manual registry of vendorized highlight.js themes.
 * Each theme is tagged with its color scheme so the UI can filter correctly.
 */
export const HLJS_THEME_REGISTRY: SyntaxHighlightThemeDefinition[] = [
  {
    id: "atom-one-light",
    label: "Atom One Light",
    colorScheme: "light",
    cssPath: "/hljs-themes/atom-one-light.css",
  },
  {
    id: "github",
    label: "GitHub",
    colorScheme: "light",
    cssPath: "/hljs-themes/github.css",
  },
  {
    id: "atom-one-dark",
    label: "Atom One Dark",
    colorScheme: "dark",
    cssPath: "/hljs-themes/atom-one-dark.css",
  },
  {
    id: "github-dark",
    label: "GitHub Dark",
    colorScheme: "dark",
    cssPath: "/hljs-themes/github-dark.css",
  },
];

export const LIGHT_THEMES = HLJS_THEME_REGISTRY.filter((t) => t.colorScheme === "light");
export const DARK_THEMES = HLJS_THEME_REGISTRY.filter((t) => t.colorScheme === "dark");

const STORAGE_KEY = "syntax-highlight-preferences";
const CHANGE_EVENT = "syntax-highlight-preferences-change";

export interface SyntaxHighlightPreferences {
  colorSchemeMode: ColorSchemeMode;
  preferredLightTheme: string;
  preferredDarkTheme: string;
}

const DEFAULTS: SyntaxHighlightPreferences = {
  colorSchemeMode: "system",
  preferredLightTheme: "atom-one-light",
  preferredDarkTheme: "atom-one-dark",
};

function read(): SyntaxHighlightPreferences {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return DEFAULTS;
  }
}

export function useSyntaxHighlightPreferences() {
  const [prefs, setPrefs] = useState(DEFAULTS);

  // Hydrate from localStorage on mount and listen for cross-instance changes
  useEffect(() => {
    setPrefs(read());

    const onChange = () => setPrefs(read());
    window.addEventListener(CHANGE_EVENT, onChange);
    return () => window.removeEventListener(CHANGE_EVENT, onChange);
  }, []);

  const update = useCallback((patch: Partial<SyntaxHighlightPreferences>) => {
    setPrefs((prev) => ({ ...prev, ...patch }));
    const next = { ...read(), ...patch };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
  }, []);

  return { ...prefs, update };
}
