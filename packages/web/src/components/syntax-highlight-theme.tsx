"use client";

import { useTheme } from "next-themes";
import { useEffect } from "react";
import {
  useSyntaxHighlightPreferences,
  HLJS_THEME_REGISTRY,
  LIGHT_THEMES,
  DARK_THEMES,
} from "@/hooks/use-syntax-highlight-preferences";

const LINK_ID = "hljs-theme-link";

/**
 * Dynamically loads the appropriate highlight.js theme stylesheet based on
 * user preferences. Must be rendered as a single instance (in Providers).
 */
export function SyntaxHighlightTheme() {
  const { resolvedTheme } = useTheme();
  const { colorSchemeMode, preferredLightTheme, preferredDarkTheme } =
    useSyntaxHighlightPreferences();

  useEffect(() => {
    // Determine which color scheme is active
    let activeScheme: "light" | "dark";
    if (colorSchemeMode === "system") {
      activeScheme = (resolvedTheme as "light" | "dark") ?? "light";
    } else {
      activeScheme = colorSchemeMode;
    }

    // Pick the user's preferred theme for that scheme, falling back to first registry entry
    const themeId = activeScheme === "dark" ? preferredDarkTheme : preferredLightTheme;
    const fallbackThemes = activeScheme === "dark" ? DARK_THEMES : LIGHT_THEMES;
    const themeDef = HLJS_THEME_REGISTRY.find((t) => t.id === themeId) ?? fallbackThemes[0];
    const href = themeDef.cssPath;

    // Reuse a single link element by ID — no duplication, no accumulation
    let link = document.getElementById(LINK_ID) as HTMLLinkElement | null;
    if (link) {
      if (link.getAttribute("href") === href) return;
      link.href = href;
    } else {
      link = document.createElement("link");
      link.id = LINK_ID;
      link.rel = "stylesheet";
      link.href = href;
      document.head.appendChild(link);
    }
  }, [resolvedTheme, colorSchemeMode, preferredLightTheme, preferredDarkTheme]);

  return null;
}
