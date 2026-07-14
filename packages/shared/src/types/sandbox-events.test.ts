import { describe, expect, it } from "vitest";
import { listEventsResponseSchema } from "./sandbox-events";

describe("listEventsResponseSchema", () => {
  it("parses a valid events response", () => {
    const result = listEventsResponseSchema.safeParse({
      events: [
        {
          id: "event-1",
          type: "token",
          data: { content: "done" },
          messageId: "message-1",
          createdAt: 1_700_000_000_000,
        },
      ],
      cursor: "next-cursor",
      hasMore: true,
    });

    expect(result.success).toBe(true);
  });

  it("rejects a malformed partial events response", () => {
    const result = listEventsResponseSchema.safeParse({
      events: [{ id: "event-1", type: "token", data: { content: "done" } }],
      hasMore: false,
    });

    expect(result.success).toBe(false);
  });

  it("parses nullable event message ids", () => {
    const result = listEventsResponseSchema.safeParse({
      events: [
        {
          id: "event-1",
          type: "heartbeat",
          data: { status: "ready" },
          messageId: null,
          createdAt: 1_700_000_000_000,
        },
      ],
      hasMore: false,
    });

    expect(result.success).toBe(true);
  });
});
