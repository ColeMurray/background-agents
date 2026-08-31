/** Strict wall-clock bound for browser WebSocket authorization. */
export const WS_AUTHORIZATION_LEASE_MS = 5 * 60 * 1000;

/** Signals that the browser must discard its credential and reconnect fresh. */
export const WS_CLOSE_AUTHORIZATION_REVOKED = 4010;

export const WS_AUTHORIZATION_REVOKED_REASON = "Authorization expired or changed";
