import { DEFAULT_APP_NAME } from "@open-inspect/shared";

export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME?.trim() || DEFAULT_APP_NAME;

export const DEFAULT_APP_SHORT_NAME = "Inspect";

/**
 * Short brand label shown in the sidebar header.
 * Defaults to "Inspect" for the built-in brand. Set NEXT_PUBLIC_APP_SHORT_NAME
 * to override, or customize NEXT_PUBLIC_APP_NAME to use that as the fallback.
 */
export const APP_SHORT_NAME =
  process.env.NEXT_PUBLIC_APP_SHORT_NAME?.trim() ||
  (APP_NAME === DEFAULT_APP_NAME ? DEFAULT_APP_SHORT_NAME : APP_NAME);

export const APP_ICON_URL = process.env.NEXT_PUBLIC_APP_ICON_URL?.trim() || "";
