// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxEvent } from "@/types/session";
import { createSessionSocketState } from "@/lib/session-socket/reducer";
import type { ServerMessage, SessionSnapshot } from "@open-inspect/shared/types/server-messages";
import {
  QUIET_TURN_CONNECTION_FRESHNESS_MS,
  QUIET_TURN_NOTICE_DELAY_MS,
  useQuietTurnNotice,
} from "./use-quiet-turn-notice";

const START_MS = 1_800_000_000_000;

function snapshot(events?: SandboxEvent[]): SessionSnapshot {
  return {
    session: {
      id: "session-1",
      title: "Quiet turn",
      repoOwner: "acme",
      repoName: "app",
      baseBranch: "main",
      branchName: "feature",
      status: "active",
      sandboxStatus: "ready",
      harness: "claude",
      messageCount: 1,
      createdAt: START_MS,
      isProcessing: true,
    },
    artifacts: [],
    promptQueue: [{ messageId: "message-1", content: "Work", status: "processing" }],
    timeline: {
      events: (
        events ?? [
          {
            type: "user_message",
            messageId: "message-1",
            content: "Work",
            timestamp: START_MS / 1000,
          },
        ]
      ).map((event, index) => ({ event, eventId: `event-${index}`, timelineSequence: index })),
      hasMore: false,
      cursor: null,
    },
  };
}

function renderNotice(initialSnapshot = snapshot()) {
  let state = createSessionSocketState(initialSnapshot);
  const hook = renderHook(({ state: nextState }) => useQuietTurnNotice(nextState), {
    initialProps: { state },
  });
  const receive = (message: ServerMessage) => {
    act(() => hook.result.current.observeMessage(message));
  };
  const reconnect = (nextSnapshot = initialSnapshot) => {
    receive({ type: "subscribed", ...nextSnapshot, participantId: "participant-1" });
    state = { ...createSessionSocketState(nextSnapshot), ready: true };
    hook.rerender({ state });
  };
  const update = (patch: Partial<typeof state>) => {
    state = { ...state, ...patch };
    hook.rerender({ state });
  };
  const advanceConnected = (durationMs: number) => {
    let remainingMs = durationMs;
    while (remainingMs > 0) {
      receive({ type: "pong", timestamp: Date.now() });
      const stepMs = Math.min(30_000, remainingMs);
      act(() => vi.advanceTimersByTime(stepMs));
      remainingMs -= stepMs;
    }
  };
  return { ...hook, reconnect, update, receive, advanceConnected, getState: () => state };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START_MS);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("quiet turn notice", () => {
  it("waits for a connected active turn, then appears once without appending events", () => {
    const view = renderNotice();
    act(() => vi.advanceTimersByTime(QUIET_TURN_NOTICE_DELAY_MS));
    expect(view.result.current.quietTurnMessageId).toBeNull();

    view.reconnect();
    expect(view.result.current.quietTurnMessageId).toBe("message-1");
    const events = view.getState().events;
    view.advanceConnected(QUIET_TURN_NOTICE_DELAY_MS * 2);
    expect(view.result.current.quietTurnMessageId).toBe("message-1");
    expect(view.getState().events).toBe(events);
    expect(events).toHaveLength(1);
  });

  it("resets on buffered token output, while heartbeats and unscoped warnings are not activity", () => {
    const view = renderNotice();
    view.reconnect();
    view.advanceConnected(QUIET_TURN_NOTICE_DELAY_MS - 1_000);
    expect(view.result.current.quietTurnMessageId).toBeNull();
    view.receive({
      type: "sandbox_event",
      event: {
        type: "heartbeat",
        sandboxId: "sandbox-1",
        status: "busy",
        timestamp: Date.now() / 1000,
      },
    });
    view.update({
      events: [
        ...view.getState().events,
        {
          type: "warning",
          scope: "provider",
          message: "Provider diagnostic",
          timestamp: Date.now() / 1000,
        },
      ],
    });
    view.advanceConnected(1_000);
    expect(view.result.current.quietTurnMessageId).toBe("message-1");

    view.receive({
      type: "sandbox_event",
      event: {
        type: "token",
        sandboxId: "sandbox-1",
        messageId: "message-1",
        content: "Continuing",
        timestamp: Date.now() / 1000,
      },
    });
    expect(view.result.current.quietTurnMessageId).toBeNull();
    view.advanceConnected(QUIET_TURN_NOTICE_DELAY_MS - 1_000);
    expect(view.result.current.quietTurnMessageId).toBeNull();
    view.advanceConnected(1_000);
    expect(view.result.current.quietTurnMessageId).toBe("message-1");
  });

  it("clears on meaningful tool output and ignores output scoped to a different message", () => {
    const view = renderNotice();
    view.reconnect();
    view.advanceConnected(QUIET_TURN_NOTICE_DELAY_MS);
    view.receive({
      type: "sandbox_event",
      event: {
        type: "token",
        sandboxId: "sandbox-1",
        messageId: "previous-message",
        content: "Late output",
        timestamp: Date.now() / 1000,
      },
    });
    expect(view.result.current.quietTurnMessageId).toBe("message-1");
    view.update({
      events: [
        ...view.getState().events,
        {
          type: "tool_call",
          sandboxId: "sandbox-1",
          messageId: "message-1",
          tool: "bash",
          callId: "call-1",
          args: {},
          status: "completed",
          timestamp: Date.now() / 1000,
        },
      ],
    });
    expect(view.result.current.quietTurnMessageId).toBeNull();
  });

  it("does not restart the presentation timer for frequent heartbeat events", () => {
    const view = renderNotice();
    view.reconnect();
    view.advanceConnected(QUIET_TURN_NOTICE_DELAY_MS - 1_000);
    const userMessage = view.getState().events[0];
    for (let tick = 0; tick < 4; tick += 1) {
      const heartbeat: SandboxEvent = {
        type: "heartbeat",
        sandboxId: "sandbox-1",
        status: "busy",
        timestamp: Date.now() / 1000,
      };
      view.receive({ type: "sandbox_event", event: heartbeat });
      view.update({ events: [userMessage, heartbeat] });
      act(() => vi.advanceTimersByTime(250));
    }
    expect(view.result.current.quietTurnMessageId).toBe("message-1");
  });

  it("suppresses stale or unknown connections and stale sandbox state", () => {
    const view = renderNotice();
    view.reconnect();
    view.advanceConnected(QUIET_TURN_NOTICE_DELAY_MS);
    expect(view.result.current.quietTurnMessageId).toBe("message-1");
    act(() => vi.advanceTimersByTime(QUIET_TURN_CONNECTION_FRESHNESS_MS));
    expect(view.result.current.quietTurnMessageId).toBeNull();
    view.update({ ready: false });
    view.advanceConnected(QUIET_TURN_NOTICE_DELAY_MS);
    expect(view.result.current.quietTurnMessageId).toBeNull();
    view.reconnect({ ...snapshot(), session: { ...snapshot().session, sandboxStatus: "stale" } });
    expect(view.result.current.quietTurnMessageId).toBeNull();
  });

  it("rederives silence from the authoritative reconnect timeline, including missed output", () => {
    const view = renderNotice();
    view.reconnect();
    view.advanceConnected(QUIET_TURN_NOTICE_DELAY_MS);
    view.update({ ready: false });
    act(() => vi.advanceTimersByTime(QUIET_TURN_NOTICE_DELAY_MS));

    const resumedSnapshot = snapshot([
      ...view.getState().events,
      {
        type: "token",
        sandboxId: "sandbox-1",
        messageId: "message-1",
        content: "Output while disconnected",
        timestamp: Date.now() / 1000,
      },
    ]);
    view.reconnect(resumedSnapshot);
    expect(view.result.current.quietTurnMessageId).toBeNull();
    view.advanceConnected(QUIET_TURN_NOTICE_DELAY_MS);
    expect(view.result.current.quietTurnMessageId).toBe("message-1");

    view.update({ ready: false });
    view.reconnect({
      ...resumedSnapshot,
      session: { ...resumedSnapshot.session, isProcessing: false },
      promptQueue: [],
    });
    expect(view.result.current.quietTurnMessageId).toBeNull();
  });

  it("clears immediately on completion even before the processing status catches up", () => {
    const view = renderNotice();
    view.reconnect();
    view.advanceConnected(QUIET_TURN_NOTICE_DELAY_MS);
    view.update({
      events: [
        ...view.getState().events,
        {
          type: "execution_complete",
          sandboxId: "sandbox-1",
          messageId: "message-1",
          success: true,
          timestamp: Date.now() / 1000,
        },
      ],
    });
    expect(view.result.current.quietTurnMessageId).toBeNull();
    view.advanceConnected(QUIET_TURN_NOTICE_DELAY_MS);
    expect(view.result.current.quietTurnMessageId).toBeNull();
  });

  it("keeps Stop suppressed for that message across reconnect, without affecting the next turn", () => {
    const view = renderNotice();
    view.reconnect();
    view.advanceConnected(QUIET_TURN_NOTICE_DELAY_MS);
    act(() => view.result.current.dismissForStop());
    expect(view.result.current.quietTurnMessageId).toBeNull();
    view.update({ ready: false });
    view.reconnect();
    view.advanceConnected(QUIET_TURN_NOTICE_DELAY_MS);
    expect(view.result.current.quietTurnMessageId).toBeNull();

    const nextSnapshot = snapshot([
      {
        type: "user_message",
        messageId: "message-2",
        content: "Next turn",
        timestamp: Date.now() / 1000,
      },
    ]);
    nextSnapshot.promptQueue = [
      { messageId: "message-2", content: "Next turn", status: "processing" },
    ];
    view.reconnect(nextSnapshot);
    expect(view.result.current.quietTurnMessageId).toBeNull();
    view.advanceConnected(QUIET_TURN_NOTICE_DELAY_MS);
    expect(view.result.current.quietTurnMessageId).toBe("message-2");
  });

  it("does not infer a turn from pending prompts or incomplete replay", () => {
    const view = renderNotice(snapshot([]));
    view.reconnect();
    view.advanceConnected(QUIET_TURN_NOTICE_DELAY_MS);
    expect(view.result.current.quietTurnMessageId).toBeNull();
    view.reconnect({
      ...snapshot(),
      promptQueue: [{ messageId: "message-1", content: "Waiting", status: "pending" }],
    });
    view.advanceConnected(QUIET_TURN_NOTICE_DELAY_MS);
    expect(view.result.current.quietTurnMessageId).toBeNull();
  });
});
