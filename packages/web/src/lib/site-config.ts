import { DEFAULT_APP_NAME } from "@open-inspect/shared";
import { resolveDefaultAppTheme } from "@/lib/app-themes";

export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME?.trim() || DEFAULT_APP_NAME;

/**
 * Default app theme applied on first load before the user picks one.
 * Configured at build time via `NEXT_PUBLIC_APP_DEFAULT_THEME` (which is
 * driven by the `app_default_theme` tfvar in production). Validated against
 * the theme registry — an unknown id falls back to "system" so a typo
 * in tfvars doesn't ship a broken UI to end users.
 */
export const APP_DEFAULT_THEME = resolveDefaultAppTheme(process.env.NEXT_PUBLIC_APP_DEFAULT_THEME);

/**
 * Short brand label shown in the sidebar header next to the logo.
 * Defaults to "Inspect" (the historical short brand). Set
 * NEXT_PUBLIC_APP_SHORT_NAME to override (defaults to APP_NAME when neither
 * is set explicitly, but stays "Inspect" for the built-in brand).
 */
export const APP_SHORT_NAME =
  process.env.NEXT_PUBLIC_APP_SHORT_NAME?.trim() ||
  (process.env.NEXT_PUBLIC_APP_NAME?.trim() ? APP_NAME : "Inspect");

export const APP_ICON_URL = process.env.NEXT_PUBLIC_APP_ICON_URL?.trim() || "";
