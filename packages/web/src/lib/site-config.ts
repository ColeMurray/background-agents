import { DEFAULT_APP_NAME } from "@open-inspect/shared";
import { resolveDefaultAppTheme } from "@/lib/app-themes";

export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME?.trim() || DEFAULT_APP_NAME;

export const DEFAULT_APP_SHORT_NAME = "Inspect";

/**
 * Default app theme applied on first load before the user picks one.
 * Configured at build time via `NEXT_PUBLIC_APP_DEFAULT_THEME` (which is
 * driven by the `app_default_theme` tfvar in production). Validated against
 * the theme registry — an unknown id falls back to "system" so a typo
 * in tfvars doesn't ship a broken UI to end users.
 */
export const APP_DEFAULT_THEME = resolveDefaultAppTheme(process.env.NEXT_PUBLIC_APP_DEFAULT_THEME);

/**
 * Short brand label shown in the sidebar header.
 * Defaults to "Inspect" for the built-in brand. Set NEXT_PUBLIC_APP_SHORT_NAME
 * to override, or customize NEXT_PUBLIC_APP_NAME to use that as the fallback.
 */
export const APP_SHORT_NAME =
  process.env.NEXT_PUBLIC_APP_SHORT_NAME?.trim() ||
  (APP_NAME === DEFAULT_APP_NAME ? DEFAULT_APP_SHORT_NAME : APP_NAME);

export const APP_ICON_URL = process.env.NEXT_PUBLIC_APP_ICON_URL?.trim() || "";
