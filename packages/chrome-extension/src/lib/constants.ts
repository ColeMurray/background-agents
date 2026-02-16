// wrench web app base url - configurable via chrome.storage or VITE_WEB_APP_URL
export const DEFAULT_WEB_APP_URL =
  import.meta.env.VITE_WEB_APP_URL || "http://localhost:3000";

// chrome.storage keys
export const STORAGE_KEYS = {
  WEB_APP_URL: "wrench_web_app_url",
  WS_URL: "wrench_ws_url",
  LAST_SESSION_ID: "wrench_last_session_id",
} as const;

// default websocket url for the control plane - configurable via VITE_WS_URL
export const DEFAULT_WS_URL =
  import.meta.env.VITE_WS_URL || "ws://localhost:8787";

// websocket close codes
export const WS_CLOSE_AUTH_REQUIRED = 4001;
export const WS_CLOSE_SESSION_EXPIRED = 4002;
