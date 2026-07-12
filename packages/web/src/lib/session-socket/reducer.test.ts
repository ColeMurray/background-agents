import { describe, expect, it } from "vitest";
import type { SandboxEvent } from "@/types/session";
import type { ServerMessage, SessionState } from "@open-inspect/shared";
import {
  initialSessionSocketState,
  sessionSocketReducer,
  type SessionSocketAction,
  type SessionSocketState,
} from "./reducer";

type SubscribedMessage = Extract<ServerMessage, { type: "subscribed" }>;

function createSessionState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    id: "session-1",
    title: "Session 1",
    repoOwner: "acme",
    repoName: "web-app",
    baseBranch: "main",
    branchName: "feature/original",
    status: "active",
    sandboxStatus: "ready",
    messageCount: 0,
    createdAt: 1,
    ...overrides,
  };
}

function createSubscribedMessage(overrides: Partial<SubscribedMessage> = {}): SubscribedMessage {
  return {
    type: "subscribed",
    sessionId: "session-1",
    state: createSessionState(),
    artifacts: [],
    participantId: "participant-1",
    participant: { participantId: "participant-1", name: "Test User" },
    replay: { events: [], hasMore: false, cursor: null },
    spawnError: null,
    ...overrides,
  };
}

function reduce(state: SessionSocketState, ...actions: SessionSocketAction[]): SessionSocketState {
  return actions.reduce(sessionSocketReducer, state);
}

function serverMessage(
  message: Exclude<ServerMessage, { type: "sandbox_event" }>
): SessionSocketAction {
  return { type: "server_message", message };
}

function subscribedState(overrides: Partial<SubscribedMessage> = {}): SessionSocketState {
  return reduce(initialSessionSocketState, serverMessage(createSubscribedMessage(overrides)));
}

describe("sessionSocketReducer", () => {
  describe("subscribed", () => {
    it("hydrates the projection and ends replay", () => {
      const state = subscribedState({
        replay: {
          events: [
            {
              type: "git_sync",
              status: "in_progress",
              sandboxId: "sb-1",
              timestamp: 1,
            },
          ],
          hasMore: true,
          cursor: { timestamp: 1, id: "evt-1" },
        },
      });

      expect(state.replaying).toBe(false);
      expect(state.sessionState).toEqual(
        expect.objectContaining({ id: "session-1", isProcessing: false, totalCost: 0 })
      );
      expect(state.currentParticipantId).toBe("participant-1");
      expect(state.events).toHaveLength(1);
      expect(state.hasMoreHistory).toBe(true);
      expect(state.cursor).toEqual({ timestamp: 1, id: "evt-1" });
    });

    it("collapses replayed token events to one final token before its completion", () => {
      const state = subscribedState({
        replay: {
          events: [
            {
              type: "execution_complete",
              messageId: "msg-1",
              success: true,
              sandboxId: "sb-1",
              timestamp: 2,
            },
            {
              type: "token",
              content: "Final",
              messageId: "msg-1",
              sandboxId: "sb-1",
              timestamp: 1,
            },
          ],
          hasMore: false,
          cursor: null,
        },
      });

      expect(state.events.map((event) => event.type)).toEqual(["token", "execution_complete"]);
    });

    it("replaces stale artifacts and events with the subscribed snapshot", () => {
      const populated = subscribedState({
        artifacts: [
          {
            id: "artifact-pr-1",
            type: "pr",
            url: "https://github.com/acme/web-app/pull/1",
            metadata: { number: 1, state: "open" },
            createdAt: 100,
          },
        ],
      });
      expect(populated.artifacts).toHaveLength(1);

      const resynced = reduce(populated, serverMessage(createSubscribedMessage()));
      expect(resynced.artifacts).toEqual([]);
      expect(resynced.events).toEqual([]);
    });

    it("preserves existing isProcessing and totalCost from the snapshot", () => {
      const state = subscribedState({
        state: createSessionState({ isProcessing: true, totalCost: 1.25 }),
      });
      expect(state.sessionState?.isProcessing).toBe(true);
      expect(state.sessionState?.totalCost).toBe(1.25);
    });
  });

  describe("events_appended", () => {
    it("appends events in order", () => {
      const events: SandboxEvent[] = [
        { type: "token", content: "final", messageId: "msg-1", sandboxId: "sb-1", timestamp: 1 },
        {
          type: "execution_complete",
          messageId: "msg-1",
          success: true,
          sandboxId: "sb-1",
          timestamp: 2,
        },
      ];
      const state = reduce(subscribedState(), { type: "events_appended", events });
      expect(state.events).toEqual(events);
    });

    it("accumulates step_finish cost onto the session total", () => {
      const base = subscribedState({ state: createSessionState({ totalCost: 1 }) });
      const state = reduce(base, {
        type: "events_appended",
        events: [
          { type: "step_finish", cost: 0.5, messageId: "msg-1", sandboxId: "sb-1", timestamp: 1 },
        ],
      });
      expect(state.sessionState?.totalCost).toBe(1.5);
    });

    it("ignores missing, non-finite, and non-positive costs", () => {
      const base = subscribedState({ state: createSessionState({ totalCost: 1 }) });
      const state = reduce(base, {
        type: "events_appended",
        events: [
          { type: "step_finish", messageId: "msg-1", sandboxId: "sb-1", timestamp: 1 },
          { type: "step_finish", cost: NaN, messageId: "msg-2", sandboxId: "sb-1", timestamp: 2 },
          { type: "step_finish", cost: -2, messageId: "msg-3", sandboxId: "sb-1", timestamp: 3 },
          { type: "step_finish", cost: 0, messageId: "msg-4", sandboxId: "sb-1", timestamp: 4 },
        ],
      });
      expect(state.sessionState?.totalCost).toBe(1);
    });
  });

  describe("history", () => {
    it("marks loading on request and prepends the fetched page", () => {
      const base = reduce(
        subscribedState({
          replay: {
            events: [{ type: "git_sync", status: "completed", sandboxId: "sb-1", timestamp: 10 }],
            hasMore: true,
            cursor: { timestamp: 10, id: "evt-10" },
          },
        }),
        { type: "history_requested" }
      );
      expect(base.loadingHistory).toBe(true);

      const state = reduce(
        base,
        serverMessage({
          type: "history_page",
          items: [{ type: "git_sync", status: "in_progress", sandboxId: "sb-1", timestamp: 5 }],
          hasMore: false,
          cursor: null,
        })
      );
      expect(state.loadingHistory).toBe(false);
      expect(state.hasMoreHistory).toBe(false);
      expect(state.cursor).toBeNull();
      expect(state.events.map((event) => event.timestamp)).toEqual([5, 10]);
    });

    it("resets loading when the server rejects a request with an error", () => {
      const base = reduce(subscribedState(), { type: "history_requested" });
      const state = reduce(
        base,
        serverMessage({ type: "error", code: "bad_cursor", message: "invalid cursor" })
      );
      expect(state.loadingHistory).toBe(false);
    });
  });

  describe("presence", () => {
    it("replaces participants on sync and removes them on leave", () => {
      const participants = [
        {
          participantId: "participant-1",
          userId: "user-1",
          name: "A",
          status: "active" as const,
          lastSeen: 1,
        },
        {
          participantId: "participant-2",
          userId: "user-2",
          name: "B",
          status: "idle" as const,
          lastSeen: 2,
        },
      ];
      const synced = reduce(
        subscribedState(),
        serverMessage({ type: "presence_sync", participants })
      );
      expect(synced.participants).toEqual(participants);

      const left = reduce(synced, serverMessage({ type: "presence_leave", userId: "user-1" }));
      expect(left.participants.map((p) => p.userId)).toEqual(["user-2"]);
    });
  });

  describe("sandbox lifecycle", () => {
    const withAccessState = () =>
      reduce(
        subscribedState(),
        serverMessage({ type: "code_server_info", url: "https://code.example", password: "pw" }),
        serverMessage({ type: "ttyd_info", url: "https://ttyd.example", token: "tok" }),
        serverMessage({ type: "tunnel_urls", urls: { "3000": "https://tunnel.example" } }),
        serverMessage({ type: "sandbox_dashboard_url", url: "https://provider.example" })
      );

    it("stores access info messages on the session state", () => {
      const state = withAccessState();
      expect(state.sessionState).toEqual(
        expect.objectContaining({
          codeServerUrl: "https://code.example",
          codeServerPassword: "pw",
          ttydUrl: "https://ttyd.example",
          ttydToken: "tok",
          tunnelUrls: { "3000": "https://tunnel.example" },
          sandboxDashboardUrl: "https://provider.example",
        })
      );
    });

    it("clears credentials and the dashboard URL on a replacement start", () => {
      const state = reduce(
        withAccessState(),
        serverMessage({ type: "sandbox_status", status: "spawning" })
      );
      expect(state.sessionState?.sandboxStatus).toBe("spawning");
      expect(state.sessionState?.codeServerUrl).toBeUndefined();
      expect(state.sessionState?.ttydUrl).toBeUndefined();
      expect(state.sessionState?.tunnelUrls).toBeUndefined();
      expect(state.sessionState?.sandboxDashboardUrl).toBeUndefined();
    });

    it("clears credentials but keeps the dashboard URL on terminal statuses", () => {
      for (const status of ["stale", "stopped", "failed"] as const) {
        const state = reduce(withAccessState(), serverMessage({ type: "sandbox_status", status }));
        expect(state.sessionState?.sandboxStatus).toBe(status);
        expect(state.sessionState?.codeServerUrl).toBeUndefined();
        expect(state.sessionState?.sandboxDashboardUrl).toBe("https://provider.example");
      }
    });

    it("keeps access state for non-clearing statuses", () => {
      const state = reduce(
        withAccessState(),
        serverMessage({ type: "sandbox_status", status: "ready" })
      );
      expect(state.sessionState?.codeServerUrl).toBe("https://code.example");
      expect(state.sessionState?.sandboxDashboardUrl).toBe("https://provider.example");
    });

    it("fails the sandbox and clears credentials on sandbox_error, keeping the dashboard URL", () => {
      const state = reduce(
        withAccessState(),
        serverMessage({ type: "sandbox_error", error: "boom" })
      );
      expect(state.sessionState?.sandboxStatus).toBe("failed");
      expect(state.sessionState?.codeServerUrl).toBeUndefined();
      expect(state.sessionState?.sandboxDashboardUrl).toBe("https://provider.example");
    });

    it("tracks warming, spawning, and ready transitions", () => {
      let state = reduce(subscribedState(), serverMessage({ type: "sandbox_warming" }));
      expect(state.sessionState?.sandboxStatus).toBe("warming");
      state = reduce(state, serverMessage({ type: "sandbox_spawning" }));
      expect(state.sessionState?.sandboxStatus).toBe("spawning");
      state = reduce(state, serverMessage({ type: "sandbox_ready" }));
      expect(state.sessionState?.sandboxStatus).toBe("ready");
    });
  });

  describe("session metadata", () => {
    it("applies title, status, and processing updates", () => {
      const state = reduce(
        subscribedState(),
        serverMessage({ type: "session_title", title: "Generated title" }),
        serverMessage({ type: "session_status", status: "completed" }),
        serverMessage({ type: "processing_status", isProcessing: true })
      );
      expect(state.sessionState).toEqual(
        expect.objectContaining({
          title: "Generated title",
          status: "completed",
          isProcessing: true,
        })
      );
    });

    it("ignores an empty title", () => {
      const state = reduce(subscribedState(), serverMessage({ type: "session_title", title: "" }));
      expect(state.sessionState?.title).toBe("Session 1");
    });

    it("upserts artifacts by id, prepending new ones and replacing in place", () => {
      const pr = (id: string, createdAt: number) => ({
        id,
        type: "pr" as const,
        url: `https://github.com/acme/web-app/pull/${id}`,
        metadata: { number: 1, state: "open" },
        createdAt,
      });
      let state = reduce(
        subscribedState(),
        serverMessage({ type: "artifact_created", artifact: pr("a", 1) }),
        serverMessage({ type: "artifact_created", artifact: pr("b", 2) })
      );
      expect(state.artifacts.map((artifact) => artifact.id)).toEqual(["b", "a"]);

      state = reduce(
        state,
        serverMessage({ type: "artifact_updated", artifact: { ...pr("a", 1), updatedAt: 9 } })
      );
      expect(state.artifacts.map((artifact) => artifact.id)).toEqual(["b", "a"]);
      expect(state.artifacts[1].updatedAt).toBe(9);
    });
  });

  describe("session_branch", () => {
    it("updates the scalar branch when no repositories are hydrated", () => {
      const state = reduce(
        subscribedState(),
        serverMessage({ type: "session_branch", branchName: "feature/updated" })
      );
      expect(state.sessionState?.branchName).toBe("feature/updated");
    });

    it("routes a repo-scoped update to the matching member, mirroring the scalar only for the primary", () => {
      const repositories = [
        {
          position: 0,
          repoOwner: "acme",
          repoName: "web",
          repoId: 1,
          baseBranch: "main",
          branchName: "open-inspect/session-1",
          baseSha: null,
          currentSha: null,
          prUrl: null,
        },
        {
          position: 1,
          repoOwner: "acme",
          repoName: "api",
          repoId: 2,
          baseBranch: "main",
          branchName: null,
          baseSha: null,
          currentSha: null,
          prUrl: null,
        },
      ];
      const base = subscribedState({
        state: createSessionState({ branchName: "open-inspect/session-1", repositories }),
      });

      const secondary = reduce(
        base,
        serverMessage({
          type: "session_branch",
          branchName: "open-inspect/session-1-api",
          repoOwner: "acme",
          repoName: "api",
        })
      );
      expect(secondary.sessionState?.repositories?.[1].branchName).toBe(
        "open-inspect/session-1-api"
      );
      expect(secondary.sessionState?.branchName).toBe("open-inspect/session-1");

      const primary = reduce(
        secondary,
        serverMessage({
          type: "session_branch",
          branchName: "open-inspect/session-1-web",
          repoOwner: "acme",
          repoName: "web",
        })
      );
      expect(primary.sessionState?.repositories?.[0].branchName).toBe("open-inspect/session-1-web");
      expect(primary.sessionState?.branchName).toBe("open-inspect/session-1-web");

      // Unscoped updates on a multi-repo session are anomalous and ignored.
      const unscoped = reduce(
        primary,
        serverMessage({ type: "session_branch", branchName: "orphan" })
      );
      expect(unscoped.sessionState).toBe(primary.sessionState);
    });
  });

  describe("local actions", () => {
    it("optimistically marks the session as processing on prompt_sent", () => {
      const state = reduce(subscribedState(), { type: "prompt_sent" });
      expect(state.sessionState?.isProcessing).toBe(true);
    });

    it("ends replay when the socket closes", () => {
      const state = reduce(initialSessionSocketState, { type: "socket_closed" });
      expect(state.replaying).toBe(false);
    });

    it("leaves a null sessionState untouched for state-dependent messages", () => {
      const state = reduce(initialSessionSocketState, serverMessage({ type: "sandbox_ready" }), {
        type: "prompt_sent",
      });
      expect(state.sessionState).toBeNull();
    });
  });
});
