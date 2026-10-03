import { describe, expect, it } from "vitest";
import { TEST_SESSION_ROW } from "../router.test-support";
import {
  inboxSessionRowSchema,
  parseInboxSessionRow,
  parseViewerSessionRow,
  viewerSessionRowSchema,
} from "./session-row";

const viewerReadState = {
  unread: 1,
  latest_terminal_message_id: "message-1",
  latest_terminal_message_created_at: 123,
};

describe("viewerSessionRowSchema", () => {
  it("parses a valid persisted session row with viewer read state", () => {
    const row = { ...TEST_SESSION_ROW, ...viewerReadState };

    expect(viewerSessionRowSchema.safeParse(row).success).toBe(true);
    expect(parseViewerSessionRow(row)).toMatchObject({ id: TEST_SESSION_ROW.id, unread: 1 });
  });

  it("rejects a malformed viewer read-state row", () => {
    expect(
      viewerSessionRowSchema.safeParse({
        ...TEST_SESSION_ROW,
        ...viewerReadState,
        latest_terminal_message_created_at: "123",
      }).success
    ).toBe(false);
  });

  it("accepts null latest-message fields before a terminal message exists", () => {
    expect(
      viewerSessionRowSchema.safeParse({
        ...TEST_SESSION_ROW,
        unread: 0,
        latest_terminal_message_id: null,
        latest_terminal_message_created_at: null,
      }).success
    ).toBe(true);
  });
});

describe("inboxSessionRowSchema", () => {
  it("parses a valid persisted inbox row", () => {
    const row = {
      ...TEST_SESSION_ROW,
      ...viewerReadState,
      effective_root_session_id: TEST_SESSION_ROW.id,
      latest_updated_at: TEST_SESSION_ROW.updated_at,
      category: "needs_attention",
    };

    expect(inboxSessionRowSchema.safeParse(row).success).toBe(true);
    expect(parseInboxSessionRow(row)).toMatchObject({
      id: TEST_SESSION_ROW.id,
      category: "needs_attention",
    });
  });

  it("rejects malformed inbox category values", () => {
    expect(
      inboxSessionRowSchema.safeParse({
        ...TEST_SESSION_ROW,
        ...viewerReadState,
        effective_root_session_id: TEST_SESSION_ROW.id,
        latest_updated_at: TEST_SESSION_ROW.updated_at,
        category: "other",
      }).success
    ).toBe(false);
  });
});
