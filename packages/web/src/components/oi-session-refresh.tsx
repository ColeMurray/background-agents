"use client";

import { useEffect } from "react";
import { useSession } from "next-auth/react";

/**
 * Ping interval for web session token renewal. Must sit comfortably inside
 * OI_ACCESS_TOKEN_RENEW_WINDOW_MS (15 min) so a token entering the renew
 * window is rotated well before it expires.
 */
const OI_REFRESH_PING_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Keeps the web session token pair fresh by pinging the persistable refresh
 * route. Renewal cannot live in the NextAuth jwt callback (getServerSession
 * cannot persist rotated cookies), so this client-side pinger is what drives
 * rotation: on mount, when the tab regains focus/visibility, and on an
 * interval. Renders nothing.
 */
export function OiSessionRefresh() {
  const { status } = useSession();

  useEffect(() => {
    if (status !== "authenticated") return;

    const ping = () => {
      void fetch("/api/auth/oi-refresh", { method: "POST" }).catch(() => undefined);
    };

    ping();
    const interval = setInterval(ping, OI_REFRESH_PING_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") ping();
    };
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [status]);

  return null;
}
