// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ParticipantPresence, SandboxEvent } from "@open-inspect/shared";
import { useSessionParticipantProfiles } from "./use-session-participant-profiles";

const swrState = vi.hoisted(() => ({ data: undefined as unknown, mutate: vi.fn() }));

vi.mock("swr", () => ({
  default: vi.fn(() => ({ data: swrState.data, mutate: swrState.mutate })),
}));

const presence: ParticipantPresence = {
  participantId: "participant-1",
  userId: "user-1",
  name: "SCM Ada",
  avatar: "https://github.example/ada",
  status: "active",
  lastSeen: 1,
};

function userMessage(userId?: string): SandboxEvent {
  return {
    type: "user_message",
    content: "hello",
    messageId: "message-1",
    timestamp: 1,
    author: {
      participantId: "participant-1",
      ...(userId ? { userId } : {}),
      name: "Historical Ada",
    },
  };
}

describe("useSessionParticipantProfiles", () => {
  beforeEach(() => {
    swrState.data = undefined;
    swrState.mutate.mockReset();
  });
  afterEach(cleanup);

  it("joins canonical names and avatars onto presence by userId", () => {
    swrState.data = {
      profiles: {
        "user-1": {
          userId: "user-1",
          displayName: "Ada Lovelace",
          avatarUrl: "https://avatars.example/ada",
        },
      },
    };

    const { result } = renderHook(() => useSessionParticipantProfiles("session-1", [presence], []));

    expect(result.current.participants[0]).toEqual(
      expect.objectContaining({
        name: "Ada Lovelace",
        avatar: "https://avatars.example/ada",
      })
    );
  });

  it("uses socket fallbacks while profiles are unavailable or deleted", () => {
    swrState.data = { profiles: {} };

    const { result } = renderHook(() =>
      useSessionParticipantProfiles("session-1", [presence], [userMessage()])
    );

    expect(result.current.participants[0]).toEqual(presence);
  });

  it("preserves transport fallbacks when canonical profile fields are null", () => {
    swrState.data = {
      profiles: {
        "user-1": { userId: "user-1", displayName: null, avatarUrl: null },
      },
    };

    const { result } = renderHook(() => useSessionParticipantProfiles("session-1", [presence], []));

    expect(result.current.participants[0]).toEqual(presence);
  });

  it("revalidates once when presence or events introduce an unknown userId", async () => {
    swrState.data = { profiles: {} };
    const { rerender } = renderHook(
      ({ events }) => useSessionParticipantProfiles("session-1", [presence], events),
      { initialProps: { events: [] as SandboxEvent[] } }
    );

    await waitFor(() => expect(swrState.mutate).toHaveBeenCalledTimes(1));
    rerender({ events: [userMessage("user-2")] });
    await waitFor(() => expect(swrState.mutate).toHaveBeenCalledTimes(2));
    rerender({ events: [userMessage("user-2")] });
    expect(swrState.mutate).toHaveBeenCalledTimes(2);
  });
});
