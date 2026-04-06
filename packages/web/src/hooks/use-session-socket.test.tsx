// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ServerMessage, SessionArtifact, SessionState } from "@open-inspect/shared";
import type * as SwrModule from "swr";
import { useSessionSocket } from "./use-session-socket";

const { mutateMock } = vi.hoisted(() => ({
  mutateMock: vi.fn(),
}));

vi.mock("swr", async () => {
  const actual = await vi.importActual<typeof SwrModule>("swr");
  return {
    ...actual,
    mutate: mutateMock,
  };
});

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readyState = FakeWebSocket.CONNECTING;
  sentMessages: Array<Record<string, unknown>> = [];

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sentMessages.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(code = 1000, reason = "") {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason, wasClean: true } as CloseEvent);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  receive(message: ServerMessage) {
    this.onmessage?.({
      data: JSON.stringify(message),
    } as MessageEvent);
  }
}

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

function createSubscribedMessage(artifacts: SessionArtifact[] = []): ServerMessage {
  return {
    type: "subscribed",
    sessionId: "session-1",
    state: createSessionState(),
    artifacts,
    participantId: "participant-1",
    participant: {
      participantId: "participant-1",
      name: "Test User",
    },
    replay: {
      events: [],
      hasMore: false,
      cursor: null,
    },
    spawnError: null,
  };
}

describe("useSessionSocket", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    mutateMock.mockReset();
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          token: "ws-token",
        })
      )
    );
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("client-id");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("hydrates artifacts from the subscribed payload", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1"));

    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    const socket = FakeWebSocket.instances[0];
    act(() => {
      socket.open();
    });

    act(() => {
      socket.receive(
        createSubscribedMessage([
          {
            id: "artifact-pr-1",
            type: "pr",
            url: "https://github.com/acme/web-app/pull/42",
            metadata: {
              number: 42,
              state: "open",
              head: "feature/test",
              base: "main",
            },
            createdAt: 1234,
          },
        ])
      );
    });

    await waitFor(() => {
      expect(result.current.artifacts).toEqual([
        {
          id: "artifact-pr-1",
          type: "pr",
          url: "https://github.com/acme/web-app/pull/42",
          metadata: {
            prNumber: 42,
            prState: "open",
            head: "feature/test",
            base: "main",
            mode: undefined,
            createPrUrl: undefined,
            provider: undefined,
            filename: undefined,
            previewStatus: undefined,
          },
          createdAt: 1234,
        },
      ]);
    });
  });

  it("replaces stale artifacts with the subscribed snapshot", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1"));

    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    const socket = FakeWebSocket.instances[0];
    act(() => {
      socket.open();
      socket.receive(
        createSubscribedMessage([
          {
            id: "artifact-pr-1",
            type: "pr",
            url: "https://github.com/acme/web-app/pull/42",
            metadata: { number: 42, state: "open" },
            createdAt: 1234,
          },
        ])
      );
    });

    await waitFor(() => {
      expect(result.current.artifacts).toHaveLength(1);
    });

    act(() => {
      socket.receive(createSubscribedMessage());
    });

    await waitFor(() => {
      expect(result.current.artifacts).toEqual([]);
    });
  });

  it("updates sessionState.branchName from session_branch without mutating the sidebar cache", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1"));

    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    const socket = FakeWebSocket.instances[0];
    act(() => {
      socket.open();
      socket.receive(createSubscribedMessage());
    });

    act(() => {
      socket.receive({ type: "session_branch", branchName: "feature/live-update" });
    });

    await waitFor(() => {
      expect(result.current.sessionState?.branchName).toBe("feature/live-update");
    });
    expect(mutateMock).not.toHaveBeenCalled();
  });

  it("prepends new artifacts and replaces duplicates by id", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1"));

    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    const socket = FakeWebSocket.instances[0];
    act(() => {
      socket.open();
      socket.receive(
        createSubscribedMessage([
          {
            id: "artifact-pr-1",
            type: "pr",
            url: "https://github.com/acme/web-app/pull/1",
            metadata: { number: 1, state: "open" },
            createdAt: 100,
          },
        ])
      );
    });

    act(() => {
      socket.receive({
        type: "artifact_created",
        artifact: {
          id: "artifact-pr-2",
          type: "pr",
          url: "https://github.com/acme/web-app/pull/2",
          metadata: { number: 2, state: "draft" },
          createdAt: 200,
        },
      });
    });

    await waitFor(() => {
      expect(result.current.artifacts.map((artifact) => artifact.id)).toEqual([
        "artifact-pr-2",
        "artifact-pr-1",
      ]);
    });

    act(() => {
      socket.receive({
        type: "artifact_created",
        artifact: {
          id: "artifact-pr-1",
          type: "pr",
          url: "https://github.com/acme/web-app/pull/1-updated",
          metadata: { number: 1, state: "closed" },
          createdAt: 300,
        },
      });
    });

    await waitFor(() => {
      expect(result.current.artifacts).toEqual([
        {
          id: "artifact-pr-2",
          type: "pr",
          url: "https://github.com/acme/web-app/pull/2",
          metadata: {
            prNumber: 2,
            prState: "draft",
            mode: undefined,
            createPrUrl: undefined,
            head: undefined,
            base: undefined,
            provider: undefined,
            filename: undefined,
            previewStatus: undefined,
          },
          createdAt: 200,
        },
        {
          id: "artifact-pr-1",
          type: "pr",
          url: "https://github.com/acme/web-app/pull/1-updated",
          metadata: {
            prNumber: 1,
            prState: "closed",
            mode: undefined,
            createPrUrl: undefined,
            head: undefined,
            base: undefined,
            provider: undefined,
            filename: undefined,
            previewStatus: undefined,
          },
          createdAt: 300,
        },
      ]);
    });
  });
});
