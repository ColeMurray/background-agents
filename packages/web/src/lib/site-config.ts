import { DEFAULT_APP_NAME } from "@open-inspect/shared";

export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME?.trim() || DEFAULT_APP_NAME;

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
