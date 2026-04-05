"use client";

/**
 * Lightweight hook that subscribes to a warming session's WebSocket
 * solely to capture the skills_discovered event. Used on the welcome
 * page so the slash palette can show skills before the first prompt.
 *
 * Unlike useSessionSocket, this hook:
 * - Only listens for skills_discovered (ignores everything else)
 * - Disconnects as soon as skills arrive (or on unmount)
 * - Does not track events, artifacts, or session state
 */

import { useState, useEffect, useRef, useCallback } from "react";
import type { SkillInfo } from "@open-inspect/shared";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:8787";

export function useWarmSkills(sessionId: string | null): SkillInfo[] {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const mountedRef = useRef(true);

  const cleanup = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cleanup();
    };
  }, [cleanup]);

  useEffect(() => {
    if (!sessionId) {
      setSkills([]);
      cleanup();
      return;
    }

    let cancelled = false;

    (async () => {
      // Fetch a WS auth token for this session.
      try {
        const res = await fetch(`/api/sessions/${sessionId}/ws-token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });
        if (!res.ok || cancelled) return;
        const { token } = await res.json();

        if (cancelled || !mountedRef.current) return;

        const ws = new WebSocket(`${WS_URL}/sessions/${sessionId}/ws`);
        wsRef.current = ws;

        ws.onopen = () => {
          ws.send(
            JSON.stringify({
              type: "subscribe",
              token,
              clientId: crypto.randomUUID(),
            })
          );
        };

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);

            // Handle skills from the subscribed replay (sessionState.skills)
            if (data.type === "subscribed" && data.state?.skills?.length) {
              if (mountedRef.current) setSkills(data.state.skills);
              // Got skills from state — done.
              ws.close();
              return;
            }

            // Handle live skills_discovered event
            if (
              data.type === "sandbox_event" &&
              data.event?.type === "skills_discovered" &&
              Array.isArray(data.event.skills)
            ) {
              if (mountedRef.current) setSkills(data.event.skills);
              // Got skills — done.
              ws.close();
              return;
            }
          } catch {
            // Ignore parse errors
          }
        };

        ws.onclose = () => {
          if (wsRef.current === ws) wsRef.current = null;
        };

        ws.onerror = () => {
          ws.close();
        };
      } catch {
        // Token fetch failed — skills just won't appear early.
      }
    })();

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [sessionId, cleanup]);

  return skills;
}
