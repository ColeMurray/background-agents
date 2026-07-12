import { describe, expect, it } from "vitest";
import type { SandboxEvent } from "@/types/session";
import {
  collapseReplayTokenEvents,
  ingestLiveSandboxEvent,
  parseWsMessage,
  pendingToTokenEvent,
  toUiArtifact,
  toUiSandboxEvent,
  type PendingAssistantText,
} from "./adapters";

function tokenEvent(messageId: string, content: string, timestamp = 1): SandboxEvent {
  return { type: "token", content, messageId, sandboxId: "sb-1", timestamp };
}

function completionEvent(messageId: string, timestamp = 2): SandboxEvent {
  return { type: "execution_complete", messageId, success: true, sandboxId: "sb-1", timestamp };
}

describe("parseWsMessage", () => {
  it("returns the parsed message for a valid payload", () => {
    expect(parseWsMessage({ type: "pong", timestamp: 123 })).toEqual({
      type: "pong",
      timestamp: 123,
    });
  });

  it("returns null for unknown or malformed payloads", () => {
    expect(parseWsMessage({ type: "not_a_message" })).toBeNull();
    expect(parseWsMessage("garbage")).toBeNull();
    expect(parseWsMessage(null)).toBeNull();
  });
});

describe("toUiSandboxEvent", () => {
  it("keeps a numeric timestamp", () => {
    expect(toUiSandboxEvent(tokenEvent("msg-1", "hi", 42)).timestamp).toBe(42);
  });

  it("fills a missing timestamp with the current time in seconds", () => {
    const event = { ...tokenEvent("msg-1", "hi"), timestamp: undefined } as unknown as SandboxEvent;
    const before = Date.now() / 1000;
    const result = toUiSandboxEvent(event);
    expect(result.timestamp).toBeGreaterThanOrEqual(before);
    expect(result.timestamp).toBeLessThanOrEqual(Date.now() / 1000);
  });
});

describe("collapseReplayTokenEvents", () => {
  it("returns events unchanged when there are no renderable tokens", () => {
    const events = [completionEvent("msg-1")];
    expect(collapseReplayTokenEvents(events)).toBe(events);
  });

  it("keeps only the final token per message, placed before its completion", () => {
    const events = [
      tokenEvent("msg-1", "partial", 1),
      tokenEvent("msg-1", "final", 2),
      completionEvent("msg-1", 3),
    ];
    expect(collapseReplayTokenEvents(events)).toEqual([
      tokenEvent("msg-1", "final", 2),
      completionEvent("msg-1", 3),
    ]);
  });

  it("moves a token ahead of its completion when storage ordering is tied", () => {
    const events = [completionEvent("msg-1", 2), tokenEvent("msg-1", "final", 1)];
    expect(collapseReplayTokenEvents(events)).toEqual([
      tokenEvent("msg-1", "final", 1),
      completionEvent("msg-1", 2),
    ]);
  });

  it("appends tokens whose completion never arrived", () => {
    const events = [tokenEvent("msg-1", "orphan"), completionEvent("msg-2")];
    expect(collapseReplayTokenEvents(events)).toEqual([
      completionEvent("msg-2"),
      tokenEvent("msg-1", "orphan"),
    ]);
  });

  it("ignores token events without content or messageId", () => {
    const empty = { ...tokenEvent("msg-1", ""), content: "" } as SandboxEvent;
    const events = [empty, completionEvent("msg-1")];
    expect(collapseReplayTokenEvents(events)).toBe(events);
  });
});

describe("ingestLiveSandboxEvent", () => {
  it("buffers token events without appending", () => {
    const result = ingestLiveSandboxEvent(null, tokenEvent("msg-1", "streaming", 5));
    expect(result.append).toEqual([]);
    expect(result.pending).toEqual({
      content: "streaming",
      messageId: "msg-1",
      sandboxId: "sb-1",
      timestamp: 5,
    });
  });

  it("replaces the pending text with the latest cumulative token", () => {
    const first = ingestLiveSandboxEvent(null, tokenEvent("msg-1", "he", 1));
    const second = ingestLiveSandboxEvent(first.pending, tokenEvent("msg-1", "hello", 2));
    expect(second.pending?.content).toBe("hello");
  });

  it("flushes pending text before the completion, keeping the token timestamp", () => {
    const pending: PendingAssistantText = {
      content: "final",
      messageId: "msg-1",
      sandboxId: "sb-1",
      timestamp: 1,
    };
    const result = ingestLiveSandboxEvent(pending, completionEvent("msg-1", 2));
    expect(result.pending).toBeNull();
    expect(result.append).toEqual([tokenEvent("msg-1", "final", 1), completionEvent("msg-1", 2)]);
  });

  it("appends a completion alone when nothing is pending", () => {
    const result = ingestLiveSandboxEvent(null, completionEvent("msg-1"));
    expect(result.append).toEqual([completionEvent("msg-1")]);
    expect(result.pending).toBeNull();
  });

  it("passes other events through without touching pending text", () => {
    const pending: PendingAssistantText = {
      content: "in flight",
      messageId: "msg-1",
      sandboxId: "sb-1",
      timestamp: 1,
    };
    const toolCall: SandboxEvent = {
      type: "tool_call",
      tool: "bash",
      args: {},
      callId: "call-1",
      messageId: "msg-1",
      sandboxId: "sb-1",
      timestamp: 3,
    };
    const result = ingestLiveSandboxEvent(pending, toolCall);
    expect(result.pending).toBe(pending);
    expect(result.append).toEqual([toolCall]);
  });
});

describe("pendingToTokenEvent", () => {
  it("rebuilds a token event from pending text", () => {
    expect(
      pendingToTokenEvent({ content: "final", messageId: "msg-1", sandboxId: "sb-1", timestamp: 1 })
    ).toEqual(tokenEvent("msg-1", "final", 1));
  });
});

describe("toUiArtifact", () => {
  it("maps PR metadata and derives prState from tracked lifecycle over the legacy key", () => {
    const artifact = toUiArtifact({
      id: "artifact-pr-1",
      type: "pr",
      url: "https://github.com/acme/web/pull/1",
      metadata: {
        number: 1,
        state: "open",
        lifecycleState: "open",
        isDraft: true,
        head: "feature",
        base: "main",
      },
      createdAt: 100,
      updatedAt: 200,
    });
    expect(artifact).toEqual({
      id: "artifact-pr-1",
      type: "pr",
      url: "https://github.com/acme/web/pull/1",
      createdAt: 100,
      updatedAt: 200,
      metadata: expect.objectContaining({
        prNumber: 1,
        prState: "draft",
        head: "feature",
        base: "main",
      }),
    });
  });

  it("falls back to the legacy state key on artifacts without lifecycle tracking", () => {
    const artifact = toUiArtifact({
      id: "artifact-pr-2",
      type: "pr",
      url: "https://github.com/acme/web/pull/2",
      metadata: { number: 2, state: "closed" },
      createdAt: 100,
    });
    expect(artifact.metadata?.prState).toBe("closed");
  });

  it("drops wrong-type metadata fields during narrowing", () => {
    const artifact = toUiArtifact({
      id: "artifact-shot-1",
      type: "screenshot",
      url: "sessions/s/media/a.png",
      metadata: {
        mimeType: "image/png",
        sizeBytes: "five",
        viewport: "not-an-object",
        caption: 42,
      },
      createdAt: 100,
    });
    expect(artifact.metadata).toEqual(
      expect.objectContaining({
        mimeType: "image/png",
        sizeBytes: undefined,
        viewport: undefined,
        caption: undefined,
      })
    );
  });

  it("leaves metadata undefined when the artifact has none", () => {
    const artifact = toUiArtifact({
      id: "artifact-branch-1",
      type: "branch",
      url: null,
      metadata: null,
      createdAt: 100,
    });
    expect(artifact.metadata).toBeUndefined();
  });
});
