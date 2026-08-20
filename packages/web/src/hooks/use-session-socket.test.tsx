// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { SessionArtifact } from "@open-inspect/shared/types/artifacts";
import type {
  ServerMessage,
  SessionSnapshot,
  SessionState,
} from "@open-inspect/shared/types/server-messages";
import type * as SwrModule from "swr";
import { isUnarchivedSessionListKey } from "@/lib/session-list";
import { useSessionSocket } from "./use-session-socket";

type SubscribedMessage = Extract<ServerMessage, { type: "subscribed" }>;

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

  receive(message: unknown) {
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

function createSubscribedMessage(artifacts: SessionArtifact[] = []): SubscribedMessage {
  return {
    type: "subscribed",
    session: createSessionState(),
    artifacts,
    participantId: "participant-1",
    participant: {
      participantId: "participant-1",
      name: "Test User",
    },
    timeline: {
      events: [],
      hasMore: false,
      cursor: null,
    },
    spawnError: null,
    promptQueue: [],
  };
}

function createSnapshot(): SessionSnapshot {
  return {
    session: createSessionState(),
    artifacts: [],
    timeline: { events: [], hasMore: false, cursor: null },
    spawnError: null,
    promptQueue: [],
  };
}

function sendSandboxDashboard(socket: FakeWebSocket, sandboxId: string) {
  socket.receive({
    type: "sandbox_dashboard_url",
    url: `https://provider.example/${sandboxId}`,
  });
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

  it("keeps sendPrompt pending until the server acknowledges the queued prompt", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1", createSnapshot()));

    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    const socket = FakeWebSocket.instances[0];
    act(() => {
      socket.open();
      socket.receive(createSubscribedMessage());
    });

    let acknowledgement!: ReturnType<typeof result.current.sendPrompt>;
    act(() => {
      acknowledgement = result.current.sendPrompt("Review this", "model-1", "high");
    });

    await waitFor(() => {
      expect(socket.sentMessages).toContainEqual({
        type: "prompt",
        clientRequestId: "client-id",
        content: "Review this",
        model: "model-1",
        reasoningEffort: "high",
      });
    });

    let settled = false;
    void acknowledgement.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    act(() => {
      socket.receive({
        type: "prompt_queued",
        clientRequestId: "client-id",
        messageId: "message-1",
        position: 1,
      } as ServerMessage);
    });
    await expect(acknowledgement).resolves.toEqual({
      ok: true,
      clientRequestId: "client-id",
      messageId: "message-1",
      position: 1,
    });
  });

  it("keeps cancelPrompt pending until the matching server acknowledgement", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1", createSnapshot()));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];
    act(() => {
      socket.open();
      socket.receive(createSubscribedMessage());
    });

    let cancellation!: ReturnType<typeof result.current.cancelPrompt>;
    act(() => {
      cancellation = result.current.cancelPrompt("message-1");
    });
    await waitFor(() => {
      expect(socket.sentMessages).toContainEqual({
        type: "cancel_prompt",
        messageId: "message-1",
        clientRequestId: "client-id",
      });
    });

    let settled = false;
    void cancellation.then(() => (settled = true));
    act(() => {
      socket.receive({
        type: "prompt_cancelled",
        clientRequestId: "another-request",
        messageId: "message-1",
      } as ServerMessage);
      socket.receive({
        type: "prompt_cancelled",
        clientRequestId: "client-id",
        messageId: "another-message",
      } as ServerMessage);
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    act(() => {
      socket.receive({
        type: "prompt_cancelled",
        clientRequestId: "client-id",
        messageId: "message-1",
      } as ServerMessage);
    });
    await expect(cancellation).resolves.toEqual({ ok: true, messageId: "message-1" });
  });

  it("returns a correlated cancellation race error without treating it as success", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1", createSnapshot()));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];
    act(() => {
      socket.open();
      socket.receive(createSubscribedMessage());
    });

    const cancellation = result.current.cancelPrompt("message-1");
    await waitFor(() => expect(socket.sentMessages).toHaveLength(2));
    act(() => {
      socket.receive({
        type: "error",
        code: "PROMPT_NOT_CANCELLABLE",
        message: "This prompt is no longer pending and cannot be removed",
        clientRequestId: "client-id",
      } as ServerMessage);
    });

    await expect(cancellation).resolves.toEqual({
      ok: false,
      reason: "rejected",
      message: "This prompt is no longer pending and cannot be removed",
    });
  });

  it("sends correlated prompts without feature negotiation", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1", createSnapshot()));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];

    act(() => {
      socket.open();
      socket.receive(createSubscribedMessage());
    });

    await waitFor(() => expect(result.current.ready).toBe(true));
    void result.current.sendPrompt("Correlate this");
    await waitFor(() => {
      expect(socket.sentMessages).toContainEqual({
        type: "prompt",
        clientRequestId: "client-id",
        content: "Correlate this",
      });
    });
  });

  it("ignores unrelated acknowledgements and errors while a correlated prompt is pending", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1", createSnapshot()));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];
    act(() => {
      socket.open();
      socket.receive(createSubscribedMessage());
    });

    const acknowledgement = result.current.sendPrompt("Review this");
    act(() => {
      socket.receive({ type: "error", code: "other", message: "Unrelated failure" });
      socket.receive({
        type: "prompt_queued",
        clientRequestId: "another-client-id",
        messageId: "message-other",
        position: 1,
      } as ServerMessage);
    });
    let settled = false;
    void acknowledgement.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);

    act(() => {
      socket.receive({
        type: "error",
        code: "PROMPT_QUEUE_FULL",
        message: "The prompt queue is full",
        clientRequestId: "client-id",
      } as ServerMessage);
    });
    await expect(acknowledgement).resolves.toEqual({
      ok: false,
      reason: "rejected",
      message: "The prompt queue is full",
    });
  });

  it("immediately rejects a correlated invalid prompt with the server message", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1", createSnapshot()));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];
    act(() => {
      socket.open();
      socket.receive(createSubscribedMessage());
    });

    const acknowledgement = result.current.sendPrompt("x".repeat(65_537));
    await waitFor(() => expect(socket.sentMessages).toHaveLength(2));

    act(() => {
      socket.receive({
        type: "error",
        code: "INVALID_PROMPT",
        message: "Prompt exceeds the server limit",
        clientRequestId: "client-id",
      } as ServerMessage);
    });

    await expect(acknowledgement).resolves.toEqual({
      ok: false,
      reason: "rejected",
      message: "Prompt exceeds the server limit",
    });
  });

  it("waits for subscription and reports when a prompt cannot be sent", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1", createSnapshot()));

    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    await expect(result.current.sendPrompt("Too early")).resolves.toEqual({
      ok: false,
      reason: "disconnected",
    });

    const socket = FakeWebSocket.instances[0];
    act(() => {
      socket.open();
    });
    const acknowledgement = result.current.sendPrompt("Wait for subscription");

    act(() => {
      socket.receive(createSubscribedMessage());
    });
    await waitFor(() => {
      expect(socket.sentMessages).toContainEqual(
        expect.objectContaining({
          type: "prompt",
          content: "Wait for subscription",
        })
      );
    });

    act(() => {
      socket.close();
    });
    await expect(acknowledgement).resolves.toEqual({ ok: false, reason: "disconnected" });
  });

  it("reuses the caller's request identity when retrying after a reconnect", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1", createSnapshot()));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const firstSocket = FakeWebSocket.instances[0];
    act(() => {
      firstSocket.open();
      firstSocket.receive(createSubscribedMessage());
    });

    const firstAttempt = result.current.sendPrompt(
      "Review this",
      "model-1",
      "high",
      [{ name: "shot.png", attachmentId: "attachment-1" }],
      "stable-request-id"
    );
    await waitFor(() => expect(firstSocket.sentMessages).toHaveLength(2));
    act(() => firstSocket.close());
    await expect(firstAttempt).resolves.toEqual({ ok: false, reason: "disconnected" });

    act(() => result.current.reconnect());
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const retrySocket = FakeWebSocket.instances[1];
    act(() => {
      retrySocket.open();
      retrySocket.receive(createSubscribedMessage());
    });
    const retry = result.current.sendPrompt(
      "Review this",
      "model-1",
      "high",
      [{ name: "shot.png", attachmentId: "attachment-1" }],
      "stable-request-id"
    );

    await waitFor(() => {
      const prompts = [...firstSocket.sentMessages, ...retrySocket.sentMessages].filter(
        (message) => message.type === "prompt"
      );
      expect(prompts).toHaveLength(2);
      expect(prompts.map((message) => message.clientRequestId)).toEqual([
        "stable-request-id",
        "stable-request-id",
      ]);
      expect(prompts.map((message) => message.attachments)).toEqual([
        [{ name: "shot.png", attachmentId: "attachment-1" }],
        [{ name: "shot.png", attachmentId: "attachment-1" }],
      ]);
    });

    act(() => {
      retrySocket.receive({
        type: "prompt_queued",
        clientRequestId: "stable-request-id",
        messageId: "message-1",
        position: 1,
      } as ServerMessage);
    });
    await expect(retry).resolves.toEqual({
      ok: true,
      clientRequestId: "stable-request-id",
      messageId: "message-1",
      position: 1,
    });
  });

  it("hydrates artifacts from the subscribed payload", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1", createSnapshot()));

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
          metadata: expect.objectContaining({
            prNumber: 42,
            prState: "open",
            head: "feature/test",
            base: "main",
          }),
          createdAt: 1234,
        },
      ]);
    });
  });

  it("hydrates screenshot metadata from subscribed artifacts", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1", createSnapshot()));

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
            id: "artifact-shot-1",
            type: "screenshot",
            url: "sessions/session-1/media/artifact-shot-1.png",
            metadata: {
              objectKey: "sessions/session-1/media/artifact-shot-1.png",
              mimeType: "image/png",
              sizeBytes: 512,
              caption: "Dashboard after fix",
              sourceUrl: "http://127.0.0.1:3000",
              fullPage: true,
              annotated: false,
              viewport: { width: 1440, height: 900 },
            },
            createdAt: 1234,
          },
        ])
      );
    });

    await waitFor(() => {
      expect(result.current.artifacts).toEqual([
        {
          id: "artifact-shot-1",
          type: "screenshot",
          url: "sessions/session-1/media/artifact-shot-1.png",
          metadata: expect.objectContaining({
            objectKey: "sessions/session-1/media/artifact-shot-1.png",
            mimeType: "image/png",
            sizeBytes: 512,
            caption: "Dashboard after fix",
            sourceUrl: "http://127.0.0.1:3000",
            fullPage: true,
            annotated: false,
            viewport: { width: 1440, height: 900 },
          }),
          createdAt: 1234,
        },
      ]);
    });
  });

  it("revalidates the sidebar session list on title updates", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1", createSnapshot()));

    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    const socket = FakeWebSocket.instances[0];
    act(() => {
      socket.open();
      socket.receive(createSubscribedMessage());
      socket.receive({ type: "session_title", title: "Generated title" });
    });

    await waitFor(() => {
      expect(result.current.sessionState?.title).toBe("Generated title");
    });

    expect(mutateMock).toHaveBeenCalledWith(isUnarchivedSessionListKey);
  });

  it("hydrates replayed assistant text before completion when storage ordering is tied", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1", createSnapshot()));

    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    const socket = FakeWebSocket.instances[0];
    const subscribed = createSubscribedMessage();
    subscribed.timeline = {
      events: [
        {
          eventId: "event-1",
          timelineSequence: 1,
          event: {
            type: "token",
            content: "Final response",
            messageId: "msg-1",
            sandboxId: "sb-1",
            timestamp: 1,
          },
        },
        {
          eventId: "event-2",
          timelineSequence: 2,
          event: {
            type: "execution_complete",
            messageId: "msg-1",
            success: true,
            sandboxId: "sb-1",
            timestamp: 2,
          },
        },
      ],
      hasMore: false,
      cursor: null,
    };

    act(() => {
      socket.open();
      socket.receive(subscribed);
    });

    await waitFor(() => {
      expect(result.current.events).toEqual([
        expect.objectContaining({
          type: "token",
          content: "Final response",
          messageId: "msg-1",
        }),
        expect.objectContaining({
          type: "execution_complete",
          messageId: "msg-1",
          success: true,
        }),
      ]);
    });
  });

  it("hydrates video metadata from subscribed artifacts", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1", createSnapshot()));

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
            id: "artifact-video-1",
            type: "video",
            url: "sessions/session-1/media/artifact-video-1.mp4",
            metadata: {
              objectKey: "sessions/session-1/media/artifact-video-1.mp4",
              mimeType: "video/mp4",
              sizeBytes: 4096,
              caption: "Menu interaction",
              sourceUrl: "http://127.0.0.1:3000/start",
              endUrl: "http://127.0.0.1:3000/end",
              durationMs: 1450,
              recordingStartedAt: 1000,
              recordingEndedAt: 2450,
              dimensions: { width: 1280, height: 720 },
              truncated: false,
              hasAudio: false,
            },
            createdAt: 1234,
          },
        ])
      );
    });

    await waitFor(() => {
      expect(result.current.artifacts).toEqual([
        {
          id: "artifact-video-1",
          type: "video",
          url: "sessions/session-1/media/artifact-video-1.mp4",
          metadata: expect.objectContaining({
            objectKey: "sessions/session-1/media/artifact-video-1.mp4",
            mimeType: "video/mp4",
            sizeBytes: 4096,
            caption: "Menu interaction",
            sourceUrl: "http://127.0.0.1:3000/start",
            endUrl: "http://127.0.0.1:3000/end",
            durationMs: 1450,
            recordingStartedAt: 1000,
            recordingEndedAt: 2450,
            dimensions: { width: 1280, height: 720 },
            truncated: false,
            hasAudio: false,
          }),
          createdAt: 1234,
        },
      ]);
    });
  });

  it("drops wrong-type metadata fields during narrowing", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1", createSnapshot()));

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
            id: "artifact-shot-wrong-types",
            type: "screenshot",
            url: "sessions/session-1/media/artifact-shot-wrong-types.png",
            metadata: {
              objectKey: "sessions/session-1/media/artifact-shot-wrong-types.png",
              mimeType: "image/png",
              sizeBytes: "five",
              viewport: "not-an-object",
            },
            createdAt: 1234,
          },
        ])
      );
    });

    await waitFor(() => {
      expect(result.current.artifacts).toEqual([
        {
          id: "artifact-shot-wrong-types",
          type: "screenshot",
          url: "sessions/session-1/media/artifact-shot-wrong-types.png",
          metadata: expect.objectContaining({
            objectKey: "sessions/session-1/media/artifact-shot-wrong-types.png",
            mimeType: "image/png",
            sizeBytes: undefined,
            viewport: undefined,
          }),
          createdAt: 1234,
        },
      ]);
    });
  });

  it("replaces stale artifacts with the subscribed snapshot", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1", createSnapshot()));

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
    const { result } = renderHook(() => useSessionSocket("session-1", createSnapshot()));

    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    const socket = FakeWebSocket.instances[0];
    act(() => {
      socket.open();
      socket.receive(createSubscribedMessage());
    });
    mutateMock.mockClear();

    act(() => {
      socket.receive({ type: "session_branch", branchName: "feature/live-update" });
    });

    await waitFor(() => {
      expect(result.current.sessionState?.branchName).toBe("feature/live-update");
    });
    expect(mutateMock).not.toHaveBeenCalled();
  });

  it("routes a repo-scoped session_branch to the matching member, mirroring the scalar only for the primary", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1", createSnapshot()));

    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    const socket = FakeWebSocket.instances[0];
    const multiRepoState = createSessionState({
      branchName: "open-inspect/session-1",
      repositories: [
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
      ],
    });

    act(() => {
      socket.open();
      socket.receive({ ...createSubscribedMessage(), session: multiRepoState });
    });

    // Secondary push: update the member, leave the scalar (primary) branch alone.
    act(() => {
      socket.receive({
        type: "session_branch",
        branchName: "open-inspect/session-1-api",
        repoOwner: "acme",
        repoName: "api",
      });
    });

    await waitFor(() => {
      expect(result.current.sessionState?.repositories?.[1].branchName).toBe(
        "open-inspect/session-1-api"
      );
    });
    expect(result.current.sessionState?.repositories?.[0].branchName).toBe(
      "open-inspect/session-1"
    );
    expect(result.current.sessionState?.branchName).toBe("open-inspect/session-1");

    // Primary push: update the member and mirror to the scalar.
    act(() => {
      socket.receive({
        type: "session_branch",
        branchName: "open-inspect/session-1-web",
        repoOwner: "acme",
        repoName: "web",
      });
    });

    await waitFor(() => {
      expect(result.current.sessionState?.branchName).toBe("open-inspect/session-1-web");
    });
    expect(result.current.sessionState?.repositories?.[0].branchName).toBe(
      "open-inspect/session-1-web"
    );
  });

  it("ignores an unscoped session_branch for a multi-repo session", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1", createSnapshot()));

    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    const socket = FakeWebSocket.instances[0];
    const multiRepoState = createSessionState({
      branchName: "open-inspect/session-1",
      repositories: [
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
      ],
    });

    act(() => {
      socket.open();
      socket.receive({ ...createSubscribedMessage(), session: multiRepoState });
    });

    // An identity-less update on a multi-repo session is anomalous — it must not
    // be attributed to the primary or clobber the scalar branch.
    act(() => {
      socket.receive({ type: "session_branch", branchName: "open-inspect/session-1-orphan" });
    });

    await waitFor(() => {
      expect(result.current.sessionState?.repositories).toBeTruthy();
    });
    expect(result.current.sessionState?.branchName).toBe("open-inspect/session-1");
    expect(result.current.sessionState?.repositories?.[0].branchName).toBe(
      "open-inspect/session-1"
    );
    expect(result.current.sessionState?.repositories?.[1].branchName).toBeNull();
  });

  it("updates sessionState.sandboxDashboardUrl from sandbox_dashboard_url", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1", createSnapshot()));

    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    const socket = FakeWebSocket.instances[0];
    act(() => {
      socket.open();
      socket.receive(createSubscribedMessage());
    });

    act(() => {
      socket.receive({
        type: "sandbox_dashboard_url",
        url: "https://provider.example/sandbox-123",
      });
    });

    await waitFor(() => {
      expect(result.current.sessionState?.sandboxDashboardUrl).toBe(
        "https://provider.example/sandbox-123"
      );
    });
  });

  it("clears credentials on spawn and terminal statuses without dropping diagnostic links early", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1", createSnapshot()));

    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    const socket = FakeWebSocket.instances[0];
    act(() => {
      socket.open();
      socket.receive(createSubscribedMessage());
      sendSandboxDashboard(socket, "old-sandbox");
    });

    await waitFor(() => {
      expect(result.current.sessionState?.sandboxDashboardUrl).toBe(
        "https://provider.example/old-sandbox"
      );
    });

    act(() => {
      socket.receive({ type: "sandbox_spawning" });
    });

    await waitFor(() => {
      expect(result.current.sessionState?.sandboxStatus).toBe("spawning");
      expect(result.current.sessionState?.sandboxDashboardUrl).toBe(
        "https://provider.example/old-sandbox"
      );
    });

    act(() => {
      socket.receive({ type: "sandbox_status", status: "spawning" });
    });

    await waitFor(() => {
      expect(result.current.sessionState?.sandboxStatus).toBe("spawning");
      expect(result.current.sessionState?.sandboxDashboardUrl).toBeUndefined();
    });

    act(() => {
      sendSandboxDashboard(socket, "new-sandbox");
      socket.receive({ type: "sandbox_status", status: "failed" });
    });

    await waitFor(() => {
      expect(result.current.sessionState?.sandboxStatus).toBe("failed");
      expect(result.current.sessionState?.sandboxDashboardUrl).toBe(
        "https://provider.example/new-sandbox"
      );
    });
  });

  it("clears dashboard URL only for replacement starts, not sandbox errors", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1", createSnapshot()));

    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    const socket = FakeWebSocket.instances[0];
    act(() => {
      socket.open();
      socket.receive(createSubscribedMessage());
      sendSandboxDashboard(socket, "old-sandbox");
    });

    await waitFor(() => {
      expect(result.current.sessionState?.sandboxDashboardUrl).toBe(
        "https://provider.example/old-sandbox"
      );
    });

    act(() => {
      socket.receive({ type: "sandbox_status", status: "spawning" });
    });

    await waitFor(() => {
      expect(result.current.sessionState?.sandboxStatus).toBe("spawning");
      expect(result.current.sessionState?.sandboxDashboardUrl).toBeUndefined();
    });

    act(() => {
      sendSandboxDashboard(socket, "new-sandbox");
    });

    await waitFor(() => {
      expect(result.current.sessionState?.sandboxDashboardUrl).toBe(
        "https://provider.example/new-sandbox"
      );
    });

    act(() => {
      socket.receive({ type: "sandbox_error", error: "spawn failed" });
    });

    await waitFor(() => {
      expect(result.current.sessionState?.sandboxStatus).toBe("failed");
      expect(result.current.sessionState?.sandboxDashboardUrl).toBe(
        "https://provider.example/new-sandbox"
      );
      expect(result.current.sessionState?.codeServerUrl).toBeUndefined();
    });
  });

  it("prepends new artifacts and replaces duplicates by id", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1", createSnapshot()));

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
          metadata: expect.objectContaining({
            prNumber: 2,
            prState: "draft",
          }),
          createdAt: 200,
        },
        {
          id: "artifact-pr-1",
          type: "pr",
          url: "https://github.com/acme/web-app/pull/1-updated",
          metadata: expect.objectContaining({
            prNumber: 1,
            prState: "closed",
          }),
          createdAt: 300,
        },
      ]);
    });

    // A new PR changes the sidebar summary, so creation revalidates the
    // session list just like artifact_updated.
    expect(mutateMock).toHaveBeenCalledWith(isUnarchivedSessionListKey);
  });

  it("applies artifact_updated in place and revalidates the session list", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1", createSnapshot()));

    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    const socket = FakeWebSocket.instances[0];
    act(() => {
      socket.open();
      socket.receive(
        createSubscribedMessage([
          {
            id: "artifact-pr-2",
            type: "pr",
            url: "https://github.com/acme/web-app/pull/2",
            metadata: { number: 2, state: "open" },
            createdAt: 200,
          },
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
    mutateMock.mockClear();

    act(() => {
      socket.receive({
        type: "artifact_updated",
        artifact: {
          id: "artifact-pr-1",
          type: "pr",
          url: "https://github.com/acme/web-app/pull/1",
          metadata: {
            number: 1,
            state: "merged",
            lifecycleState: "merged",
            isDraft: false,
          },
          createdAt: 100,
          updatedAt: 500,
        },
      });
    });

    await waitFor(() => {
      // Updated in place — the list order is stable, no reshuffle.
      expect(
        result.current.artifacts.map((artifact) => [artifact.id, artifact.metadata?.prState])
      ).toEqual([
        ["artifact-pr-2", "open"],
        ["artifact-pr-1", "merged"],
      ]);
      expect(result.current.artifacts[1].updatedAt).toBe(500);
    });

    expect(mutateMock).toHaveBeenCalledWith(isUnarchivedSessionListKey);
  });

  it("does not revalidate the session list for non-PR artifacts", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1", createSnapshot()));

    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    const socket = FakeWebSocket.instances[0];
    act(() => {
      socket.open();
      socket.receive(createSubscribedMessage([]));
    });
    mutateMock.mockClear();

    act(() => {
      socket.receive({
        type: "artifact_created",
        artifact: {
          id: "artifact-shot-1",
          type: "screenshot",
          url: "https://example.com/shot.png",
          metadata: null,
          createdAt: 100,
        },
      });
    });

    await waitFor(() => {
      // The artifact still upserts into the session view; only the sidebar
      // revalidation is PR-gated (media events arrive at high frequency).
      expect(result.current.artifacts.map((artifact) => artifact.id)).toEqual(["artifact-shot-1"]);
    });
    expect(mutateMock).not.toHaveBeenCalledWith(isUnarchivedSessionListKey);
  });

  it("derives prState from tracked lifecycle metadata over the legacy state key", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1", createSnapshot()));

    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    const socket = FakeWebSocket.instances[0];
    act(() => {
      socket.open();
      socket.receive(
        createSubscribedMessage([
          {
            id: "artifact-pr-draft",
            type: "pr",
            url: "https://github.com/acme/web-app/pull/3",
            // Stale legacy display key vs. tracked lifecycle: lifecycle wins.
            metadata: { number: 3, state: "open", lifecycleState: "open", isDraft: true },
            createdAt: 100,
          },
          {
            id: "artifact-pr-legacy",
            type: "pr",
            url: "https://github.com/acme/web-app/pull/4",
            metadata: { number: 4, state: "closed" },
            createdAt: 50,
          },
        ])
      );
    });

    await waitFor(() => {
      expect(result.current.artifacts.map((artifact) => artifact.metadata?.prState)).toEqual([
        "draft",
        "closed",
      ]);
    });
  });
});
