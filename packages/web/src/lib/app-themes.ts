/**
 * App theme registry.
 *
 * Each entry corresponds to a CSS rule in `globals.css` (e.g., `.dark { ... }`,
 * `.blue { ... }`). next-themes adds the theme `id` as a class on `<html>`,
 * so the CSS selector and the registry id must match.
 *
 * `colorScheme` tells the rest of the app whether a theme reads as light or
 * dark — primarily so syntax highlighting (`syntax-highlight-theme.tsx`) can
 * pick the right hljs stylesheet when a custom palette is active.
 *
 * Adding a new theme:
 *   1. Append an entry here.
 *   2. Add a matching block in `globals.css` (e.g., `.blue { --background: ...; }`).
 *   3. (Optional) Add a `.blue.dark { ... }` block if it has a dark variant.
 *
 * See `docs/THEMING.md` for the full walkthrough.
 */

export type AppThemeColorScheme = "light" | "dark" | "system";

export interface AppTheme {
  id: string;
  label: string;
  /**
   * Whether this theme reads as light or dark. Drives syntax highlighting:
   * `syntax-highlight-theme.tsx` reads this to pick the matching light- or
   * dark-mode hljs stylesheet when a custom palette is active. Use "system"
   * only for the special System entry (resolves to light/dark via OS pref);
   * named palettes ("blue", etc.) should always pick "light" or "dark".
   */
  colorScheme: AppThemeColorScheme;
}

export const APP_THEMES: AppTheme[] = [
  { id: "light", label: "Default", colorScheme: "light" },
  { id: "dark", label: "Dark", colorScheme: "dark" },
  { id: "system", label: "System", colorScheme: "system" },
  // Example branded theme. Remove or rename to fit your deployment, and
  // adjust the matching `.blue` rule in globals.css.
  { id: "blue", label: "Blue", colorScheme: "light" },
];

export const APP_THEME_IDS = APP_THEMES.map((t) => t.id);

export const DEFAULT_APP_THEME = "system";

export function getAppTheme(id: string | undefined): AppTheme | undefined {
  return APP_THEMES.find((t) => t.id === id);
}

/**
 * Resolve a value from `NEXT_PUBLIC_APP_DEFAULT_THEME` (or any other source) to
 * a known theme id. Falls back to `DEFAULT_APP_THEME` when the input is empty
 * or doesn't match a registered theme — the deployer has no way to recover
 * from a typo in tfvars otherwise.
 */
export function resolveDefaultAppTheme(raw: string | undefined | null): string {
  const value = raw?.trim();
  if (!value) return DEFAULT_APP_THEME;
  return APP_THEME_IDS.includes(value) ? value : DEFAULT_APP_THEME;
}
