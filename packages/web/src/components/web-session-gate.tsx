"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { signOut, useSession } from "next-auth/react";

/**
 * Check interval for web session token renewal. Must sit comfortably inside
 * OI_ACCESS_TOKEN_RENEW_WINDOW_MS (15 min) so a token entering the renew
 * window is rotated well before it expires.
 */
const WEB_SESSION_CHECK_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Confirms that NextAuth and the control-plane token pair form a usable web
 * session before rendering authenticated children, then keeps that pair fresh.
 * Renewal cannot live in the NextAuth jwt callback (getServerSession cannot
 * persist rotated cookies), so this client-side gate drives rotation on
 * mount, focus/visibility, and an interval.
 */
export function WebSessionGate({ children }: { children?: ReactNode }) {
  const { status } = useSession();
  const signingOutRef = useRef(false);
  const [webSessionStatus, setWebSessionStatus] = useState<
    "checking" | "ready" | "temporarily_unavailable"
  >("checking");
  const [retryGeneration, setRetryGeneration] = useState(0);

  useEffect(() => {
    if (status === "authenticated") return;
    setWebSessionStatus("checking");
    signingOutRef.current = false;
  }, [status]);

  useEffect(() => {
    if (status !== "authenticated") return;
    let cancelled = false;
    let checkInFlight = false;

    const checkWebSession = async () => {
      if (checkInFlight) return;
      checkInFlight = true;
      try {
        const response = await fetch("/api/auth/oi-refresh", { method: "POST" });
        if (cancelled) return;
        if (response.status === 401 && !signingOutRef.current) {
          signingOutRef.current = true;
          try {
            await signOut();
          } catch {
            if (!cancelled) {
              signingOutRef.current = false;
              setWebSessionStatus("temporarily_unavailable");
            }
          }
          return;
        }
        if (response.ok) {
          setWebSessionStatus("ready");
          return;
        }
        setWebSessionStatus("temporarily_unavailable");
      } catch {
        if (!cancelled) {
          setWebSessionStatus("temporarily_unavailable");
        }
      } finally {
        checkInFlight = false;
      }
    };

    void checkWebSession();
    const checkInterval = setInterval(() => void checkWebSession(), WEB_SESSION_CHECK_INTERVAL_MS);
    const checkWhenVisible = () => {
      if (document.visibilityState === "visible") void checkWebSession();
    };
    window.addEventListener("focus", checkWhenVisible);
    document.addEventListener("visibilitychange", checkWhenVisible);
    return () => {
      cancelled = true;
      clearInterval(checkInterval);
      window.removeEventListener("focus", checkWhenVisible);
      document.removeEventListener("visibilitychange", checkWhenVisible);
    };
  }, [retryGeneration, status]);

  if (status === "unauthenticated") return children ?? null;
  if (status !== "authenticated") return null;
  if (webSessionStatus === "temporarily_unavailable") {
    return (
      <main className="flex min-h-screen items-center justify-center p-6">
        <div className="space-y-3 text-center">
          <p>Authentication temporarily unavailable</p>
          <button
            type="button"
            className="rounded-md border px-3 py-2"
            onClick={() => {
              setWebSessionStatus("checking");
              setRetryGeneration((generation) => generation + 1);
            }}
          >
            Retry
          </button>
        </div>
      </main>
    );
  }
  if (webSessionStatus !== "ready") return null;
  return children ?? null;
}
