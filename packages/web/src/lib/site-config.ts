import { DEFAULT_APP_NAME } from "@open-inspect/shared/app-name";

export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME?.trim() || DEFAULT_APP_NAME;

const DEFAULT_FAVICON_URL = "/favicon.ico";

export const APP_ICON_URL = process.env.NEXT_PUBLIC_APP_ICON_URL?.trim() || "";
export const APP_FAVICON_URL = APP_ICON_URL || DEFAULT_FAVICON_URL;
