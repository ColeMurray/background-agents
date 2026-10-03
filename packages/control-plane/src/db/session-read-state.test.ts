import { describe, expect, it } from "vitest";
import { readStateFromRow, viewerReadStateRowSchema } from "./session-read-state";

describe("viewerReadStateRowSchema", () => {
  it("parses a row with no terminal message", () => {
    const parsed = viewerReadStateRowSchema.safeParse({
      unread: 0,
      latest_terminal_message_id: null,
      latest_terminal_message_created_at: null,
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(readStateFromRow(parsed.data)).toEqual({
        latestMessageId: null,
        unread: false,
        version: 0,
      });
    }
  });

  it("parses a row with a terminal message", () => {
    const parsed = viewerReadStateRowSchema.safeParse({
      unread: 1,
      latest_terminal_message_id: "message-1",
      latest_terminal_message_created_at: 123,
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(readStateFromRow(parsed.data)).toEqual({
        latestMessageId: "message-1",
        unread: true,
        version: 123,
      });
    }
  });

  it("rejects non-binary unread values", () => {
    expect(
      viewerReadStateRowSchema.safeParse({
        unread: 2,
        latest_terminal_message_id: "message-1",
        latest_terminal_message_created_at: 123,
      }).success
    ).toBe(false);
  });

  it("rejects mismatched latest-message fields", () => {
    expect(
      viewerReadStateRowSchema.safeParse({
        unread: 0,
        latest_terminal_message_id: "message-1",
        latest_terminal_message_created_at: null,
      }).success
    ).toBe(false);
    expect(
      viewerReadStateRowSchema.safeParse({
        unread: 0,
        latest_terminal_message_id: null,
        latest_terminal_message_created_at: 123,
      }).success
    ).toBe(false);
  });
});
