import { DEFAULT_APP_NAME } from "@open-inspect/shared";

export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME?.trim() || DEFAULT_APP_NAME;

export const APP_ICON_URL = process.env.NEXT_PUBLIC_APP_ICON_URL?.trim() || "";
