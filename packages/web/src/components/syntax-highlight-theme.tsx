"use client";

import { useTheme } from "next-themes";
import { useEffect } from "react";

/**
 * Maps color scheme to highlight.js theme CSS files served from /hljs-themes/.
 *
 * To support user-configurable themes, extend this mapping or accept
 * theme names as props/from user settings.
 */
const HLJS_THEMES: Record<string, string> = {
  light: "/hljs-themes/atom-one-light.css",
  dark: "/hljs-themes/atom-one-dark.css",
};

/**
 * Dynamically loads the appropriate highlight.js theme stylesheet based on
 * the current color scheme. Cleanly swaps stylesheets when the theme changes.
 */
export function SyntaxHighlightTheme() {
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    const href = HLJS_THEMES[resolvedTheme ?? "light"] ?? HLJS_THEMES.light;

    // Check if this theme is already loaded
    const existing = document.querySelector(
      'link[data-hljs-theme]',
    ) as HTMLLinkElement | null;
    if (existing?.getAttribute("href") === href) return;

    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.setAttribute("data-hljs-theme", "true");

    // Swap: add new stylesheet, then remove old one once loaded to avoid FOUC
    link.onload = () => existing?.remove();
    document.head.appendChild(link);

    // Fallback removal if onload doesn't fire (e.g. cached)
    if (existing) {
      setTimeout(() => existing.remove(), 100);
    }
  }, [resolvedTheme]);

  return null;
}
