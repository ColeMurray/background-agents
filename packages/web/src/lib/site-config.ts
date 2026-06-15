import { DEFAULT_APP_NAME } from "@open-inspect/shared";

export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME?.trim() || DEFAULT_APP_NAME;

export const DEFAULT_APP_SHORT_NAME = "Inspect";
export const DEFAULT_FAVICON_URL = "/favicon.ico";

/**
 * Short brand label shown in the sidebar header.
 * Defaults to "Inspect" for the built-in brand. Set NEXT_PUBLIC_APP_SHORT_NAME
 * to override, or customize NEXT_PUBLIC_APP_NAME to use that as the fallback.
 */
export const APP_SHORT_NAME =
  process.env.NEXT_PUBLIC_APP_SHORT_NAME?.trim() ||
  (APP_NAME === DEFAULT_APP_NAME ? DEFAULT_APP_SHORT_NAME : APP_NAME);

export const APP_ICON_URL = process.env.NEXT_PUBLIC_APP_ICON_URL?.trim() || "";
export const APP_FAVICON_URL = APP_ICON_URL || DEFAULT_FAVICON_URL;

/**
 * Whether to show the "Sign in with Google" button. Build-time flag mirroring
 * the server-side conditional GoogleProvider (enabled only when both
 * GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set). The provider set is static
 * per deployment, so a build-time flag avoids an async getProviders() round-trip
 * in the sign-in client component.
 */
export const GOOGLE_LOGIN_ENABLED = process.env.NEXT_PUBLIC_GOOGLE_ENABLED?.trim() === "true";
