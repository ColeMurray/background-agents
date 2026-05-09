/**
 * App theme registry.
 *
 * Built-ins (`light`, `dark`, `system`) are wired to rules in `globals.css`.
 * Branded themes live one-per-file in `app/themes/<id>.css` and are imported
 * from `app/layout.tsx` after `globals.css`. `next-themes` adds the active
 * theme's `id` as a class on `<html>`, so the CSS selector and the registry
 * id must match.
 *
 * `colorScheme` tells the rest of the app whether a theme reads as light or
 * dark — primarily so syntax highlighting (`syntax-highlight-theme.tsx`) can
 * pick the right hljs stylesheet when a custom palette is active.
 *
 * Adding a new branded theme:
 *   1. Append an entry here.
 *   2. Create `app/themes/<id>.css` with a `.<id> { ... }` rule.
 *   3. Import it from `app/layout.tsx` after `./globals.css`.
 *   4. Add the id to the `app_default_theme` validation list in `variables.tf`.
 *
 * Each named palette is light-only or dark-only (next-themes' `attribute="class"`
 * puts only one theme class on `<html>` at a time, so `.foo.dark` never matches).
 * Register a separate `<id>-dark` theme entry + file for a dark variant.
 *
 * See `docs/THEMING.md` for the full walkthrough.
 */

/**
 * Whether a theme reads as light, dark, or follows the OS preference.
 * Reserved values; named palettes should be "light" or "dark" only.
 */
export type AppThemeColorScheme = "light" | "dark" | "system";

/**
 * One entry in the theme registry. `id` doubles as the CSS class selector
 * and the value persisted by next-themes; `label` is the human-readable
 * name shown in the Appearance picker; `colorScheme` drives syntax
 * highlighting fallback when this theme is active.
 */
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

/**
 * Registered themes, in the order they appear in the Appearance picker.
 * Each entry must have a matching CSS rule keyed by `id` — built-ins live in
 * `globals.css`, branded themes in `app/themes/<id>.css`.
 */
export const APP_THEMES: AppTheme[] = [
  { id: "light", label: "Default", colorScheme: "light" },
  { id: "dark", label: "Dark", colorScheme: "dark" },
  { id: "system", label: "System", colorScheme: "system" },
  // Example branded theme. Remove or rename to fit your deployment, and
  // adjust the matching file at `app/themes/blue.css`.
  { id: "blue", label: "Blue", colorScheme: "light" },
];

/** Theme ids in registration order — passed to next-themes' `themes` prop. */
export const APP_THEME_IDS = APP_THEMES.map((t) => t.id);

/**
 * Hard-coded fallback used when no deploy-time default is configured or the
 * configured value is invalid. "system" preserves the historical behavior.
 */
export const DEFAULT_APP_THEME = "system";

/**
 * Look up a registered theme by id. Returns `undefined` for unknown ids so
 * callers can decide how to handle them (most should fall through to the
 * resolved light/dark behavior rather than treating it as an error).
 */
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
