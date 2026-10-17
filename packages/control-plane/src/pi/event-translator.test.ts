import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@earendil-works/pi-durable";
import { translatePiEvents } from "./event-translator";

describe("translatePiEvents", () => {
  it("projects cumulative text and step activity", () => {
    const state = { text: "" };
    const events = [
      { type: "turn_start" },
      {
        type: "message_update",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        changes: [{ type: "text_delta", contentIndex: 0, delta: "Hello" }],
      },
    ] satisfies AgentEvent[];

    expect(
      translatePiEvents(events, state, {
        sessionId: "session-1",
        operationId: "message-1",
        timestamp: 123,
      })
    ).toEqual([
      expect.objectContaining({ type: "step_start", messageId: "message-1" }),
      expect.objectContaining({ type: "token", content: "Hello", partId: "message-1" }),
    ]);
  });

  it("continues cumulative text across committed batches", () => {
    const state = { text: "Hello" };
    const events = [
      {
        type: "message_update",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        changes: [{ type: "text_delta", contentIndex: 0, delta: " world" }],
      },
    ] satisfies AgentEvent[];

    expect(
      translatePiEvents(events, state, {
        sessionId: "session-1",
        operationId: "message-1",
        timestamp: 124,
      })
    ).toEqual([expect.objectContaining({ type: "token", content: "Hello world" })]);
  });
});
