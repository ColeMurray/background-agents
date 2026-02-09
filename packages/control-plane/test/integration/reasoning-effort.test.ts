import { describe, it, expect } from "vitest";
import { initSession, queryDO } from "./helpers";

describe("reasoning effort", () => {
  describe("validation", () => {
    it("stores valid reasoning effort on the message", async () => {
      const { stub } = await initSession({ model: "anthropic/claude-sonnet-4-5" });

      const res = await stub.fetch("http://internal/internal/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: "Test prompt",
          authorId: "user-1",
          source: "web",
          reasoningEffort: "high",
        }),
      });

      expect(res.status).toBe(200);
      const { messageId } = await res.json<{ messageId: string }>();
      const messages = await queryDO<{ reasoning_effort: string | null }>(
        stub,
        "SELECT reasoning_effort FROM messages WHERE id = ?",
        messageId
      );

      expect(messages[0].reasoning_effort).toBe("high");
    });

    it("ignores invalid reasoning effort", async () => {
      const { stub } = await initSession({ model: "anthropic/claude-sonnet-4-5" });

      const res = await stub.fetch("http://internal/internal/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: "Test prompt",
          authorId: "user-1",
          source: "web",
          reasoningEffort: "turbo",
        }),
      });

      expect(res.status).toBe(200);
      const { messageId } = await res.json<{ messageId: string }>();
      const messages = await queryDO<{ reasoning_effort: string | null }>(
        stub,
        "SELECT reasoning_effort FROM messages WHERE id = ?",
        messageId
      );

      expect(messages[0].reasoning_effort).toBeNull();
    });
  });

  describe("session-level persistence", () => {
    it("stores reasoning effort on the session row", async () => {
      const { stub } = await initSession({
        model: "anthropic/claude-sonnet-4-5",
        reasoningEffort: "high",
      });

      const sessions = await queryDO<{ reasoning_effort: string | null }>(
        stub,
        "SELECT reasoning_effort FROM session LIMIT 1"
      );

      expect(sessions[0].reasoning_effort).toBe("high");
    });

    it("ignores invalid reasoning effort at session creation", async () => {
      const { stub } = await initSession({
        model: "anthropic/claude-sonnet-4-5",
        reasoningEffort: "invalid",
      });

      const sessions = await queryDO<{ reasoning_effort: string | null }>(
        stub,
        "SELECT reasoning_effort FROM session LIMIT 1"
      );

      expect(sessions[0].reasoning_effort).toBeNull();
    });

    it("returns reasoning effort in GET /state", async () => {
      const { stub } = await initSession({
        model: "anthropic/claude-sonnet-4-5",
        reasoningEffort: "high",
      });

      const res = await stub.fetch("http://internal/internal/state");
      expect(res.status).toBe(200);
      const state = await res.json<{ reasoningEffort?: string }>();
      expect(state.reasoningEffort).toBe("high");
    });
  });

  describe("resolution fallback chain", () => {
    it("per-message effort takes priority over session default", async () => {
      const { stub } = await initSession({
        model: "anthropic/claude-sonnet-4-5",
        reasoningEffort: "max",
      });

      const res = await stub.fetch("http://internal/internal/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: "Test prompt",
          authorId: "user-1",
          source: "web",
          reasoningEffort: "high",
        }),
      });

      const { messageId } = await res.json<{ messageId: string }>();
      const messages = await queryDO<{ reasoning_effort: string | null }>(
        stub,
        "SELECT reasoning_effort FROM messages WHERE id = ?",
        messageId
      );

      // Per-message "high" is stored, not session-level "max"
      expect(messages[0].reasoning_effort).toBe("high");
    });

    it("falls back to session effort when message has none", async () => {
      const { stub } = await initSession({
        model: "anthropic/claude-sonnet-4-5",
        reasoningEffort: "high",
      });

      const res = await stub.fetch("http://internal/internal/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: "Test prompt",
          authorId: "user-1",
          source: "web",
          // No reasoningEffort — should fall back to session "high"
        }),
      });

      const { messageId } = await res.json<{ messageId: string }>();
      const messages = await queryDO<{ reasoning_effort: string | null }>(
        stub,
        "SELECT reasoning_effort FROM messages WHERE id = ?",
        messageId
      );

      // Message has no per-message override
      expect(messages[0].reasoning_effort).toBeNull();

      // Session still holds "high"
      const sessions = await queryDO<{ reasoning_effort: string | null }>(
        stub,
        "SELECT reasoning_effort FROM session LIMIT 1"
      );
      expect(sessions[0].reasoning_effort).toBe("high");
    });

    it("falls back to model default when neither message nor session has effort", async () => {
      const { stub } = await initSession({
        model: "anthropic/claude-sonnet-4-5",
        // No reasoningEffort on session
      });

      const res = await stub.fetch("http://internal/internal/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: "Test prompt",
          authorId: "user-1",
          source: "web",
          // No reasoningEffort on message either
        }),
      });

      const { messageId } = await res.json<{ messageId: string }>();

      // Both message and session have null — resolution falls back to model default ("max")
      const messages = await queryDO<{ reasoning_effort: string | null }>(
        stub,
        "SELECT reasoning_effort FROM messages WHERE id = ?",
        messageId
      );
      expect(messages[0].reasoning_effort).toBeNull();

      const sessions = await queryDO<{ reasoning_effort: string | null }>(
        stub,
        "SELECT reasoning_effort FROM session LIMIT 1"
      );
      expect(sessions[0].reasoning_effort).toBeNull();

      // The resolution happens at dispatch time (processNextMessage), not at storage.
      // getDefaultReasoningEffort("anthropic/claude-sonnet-4-5") returns "max".
      // We can't directly observe the dispatched command without a sandbox,
      // but we verify the stored values ensure the fallback chain will resolve to "max".
    });
  });
});
