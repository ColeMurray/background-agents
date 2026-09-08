"use client";

import type { ParticipantPresence } from "@open-inspect/shared/types/server-messages";
import type { SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import {
  sessionParticipantProfilesResponseSchema,
  type SessionParticipantProfile,
} from "@open-inspect/shared/types/sessions";
import { useEffect, useMemo, useRef } from "react";
import useSWR from "swr";
import { resolveParticipantDisplay } from "@/lib/participant-display";

export function useSessionParticipantProfiles(
  sessionId: string,
  participants: ParticipantPresence[],
  events: SandboxEvent[]
) {
  const { data, mutate } = useSWR<unknown>(
    `/api/sessions/${sessionId}/participant-profiles` as const
  );
  const attemptedUnknownIds = useRef(new Set<string>());

  const profiles = useMemo<Record<string, SessionParticipantProfile>>(() => {
    const parsed = sessionParticipantProfilesResponseSchema.safeParse(data);
    return parsed.success ? parsed.data.profiles : {};
  }, [data]);

  const observedUserIds = useMemo(() => {
    const ids = new Set(participants.map((participant) => participant.userId));
    for (const event of events) {
      if (event.type === "user_message" && event.author?.userId) ids.add(event.author.userId);
    }
    return ids;
  }, [events, participants]);

  useEffect(() => {
    attemptedUnknownIds.current.clear();
  }, [sessionId]);

  useEffect(() => {
    if (data === undefined) return;
    const unknownIds = [...observedUserIds].filter(
      (userId) => !profiles[userId] && !attemptedUnknownIds.current.has(userId)
    );
    if (unknownIds.length === 0) return;

    for (const userId of unknownIds) attemptedUnknownIds.current.add(userId);
    void mutate();
  }, [data, mutate, observedUserIds, profiles]);

  const profiledParticipants = useMemo(
    () =>
      participants.map((participant) => {
        const profile = profiles[participant.userId];
        if (!profile) return participant;
        const display = resolveParticipantDisplay(participant, profile);
        return {
          ...participant,
          ...display,
        };
      }),
    [participants, profiles]
  );

  return { profiles, participants: profiledParticipants };
}
