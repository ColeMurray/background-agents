import { describe, expect, it, vi } from "vitest";
import { persistSessionWarning } from "./session-warnings";

describe("persistSessionWarning", () => {
  it("files a prompt's warning under that prompt", () => {
    const createEventIfAbsent = vi.fn(() => true);

    const event = persistSessionWarning(
      { createEventIfAbsent },
      "Unavailable",
      "warning-1",
      2_000,
      {
        scope: "mcp",
        messageId: "msg-1",
      }
    );

    expect(event).toEqual({
      type: "warning",
      scope: "mcp",
      messageId: "msg-1",
      message: "Unavailable",
      timestamp: 2,
    });
    expect(createEventIfAbsent).toHaveBeenCalledExactlyOnceWith({
      id: "warning-1",
      type: "warning",
      data: JSON.stringify(event),
      messageId: "msg-1",
      createdAt: 2_000,
    });
  });

  it("keeps a session warning unattached and records each id once", () => {
    const createEventIfAbsent = vi.fn(() => false);

    expect(
      persistSessionWarning({ createEventIfAbsent }, "Provider", "warning-2", 2_000)
    ).toBeNull();
    expect(createEventIfAbsent).toHaveBeenCalledExactlyOnceWith({
      id: "warning-2",
      type: "warning",
      data: JSON.stringify({
        type: "warning",
        scope: "provider",
        message: "Provider",
        timestamp: 2,
      }),
      messageId: null,
      createdAt: 2_000,
    });
  });
});
