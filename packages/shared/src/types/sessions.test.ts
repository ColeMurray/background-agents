import { describe, expect, it } from "vitest";
import { sandboxStatusSchema, sessionReadActionSchema, sessionReadResultSchema } from "./sessions";
import { createSessionRequestSchema } from "./session-api";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";

describe("session read contracts", () => {
  it("accepts only explicit exact and latest read actions", () => {
    expect(
      sessionReadActionSchema.safeParse({
        action: "mark_message_read",
        messageId: "message-1",
      }).success
    ).toBe(true);
    expect(
      sessionReadActionSchema.safeParse({
        action: "mark_latest_message_read",
      }).success
    ).toBe(true);
    expect(
      sessionReadActionSchema.safeParse({
        action: "mark_latest_message_read",
        messageId: "message-1",
      }).success
    ).toBe(false);
  });

  it("reads a result without a version as version 0 and ignores additive fields", () => {
    expect(
      sessionReadResultSchema.parse({
        sessionId: "session-1",
        outcome: "marked_read",
        unread: false,
        latestMessageId: "message-1",
        extra: true,
      })
    ).toEqual({
      sessionId: "session-1",
      outcome: "marked_read",
      unread: false,
      latestMessageId: "message-1",
      version: 0,
    });
  });

  it("rejects unread state without a terminal message", () => {
    expect(
      sessionReadResultSchema.safeParse({
        sessionId: "session-1",
        outcome: "no_terminal_message",
        unread: true,
        latestMessageId: null,
      }).success
    ).toBe(false);
  });
});

describe("createSessionRequestSchema provider selections", () => {
  it("accepts omitted, empty, and explicit provider selections", () => {
    expect(createSessionRequestSchema.safeParse({}).success).toBe(true);
    expect(createSessionRequestSchema.safeParse({ providerSelections: {} }).success).toBe(true);
    expect(
      createSessionRequestSchema.safeParse({
        providerSelections: {
          openai: { mode: "provider_account", accountId: ACCOUNT_ID },
          xai: { mode: "api_key" },
        },
      }).success
    ).toBe(true);
  });

  it("rejects malformed provider selections", () => {
    expect(
      createSessionRequestSchema.safeParse({
        providerSelections: { anthropic: { mode: "api_key" } },
      }).success
    ).toBe(false);
  });
});

describe("sandbox status vocabulary", () => {
  // Pinned deliberately. `syncing` and `running` were carried in this union,
  // the zod enum, the DB schema comment, the web label map, the web
  // starting/active sets, and the Python mirror -- while no code path in any
  // language ever wrote either one. `running` was not merely unused: PR #970
  // gated sandbox authorization on it and had to be reverted (#980), because
  // the WebSocket connect writes "ready" and nothing ever writes "running".
  //
  // `warming` looks similar but is NOT dead: it is never persisted, yet the
  // client sets it optimistically on the separate `sandbox_warming` message
  // (web/src/lib/session-socket/reducer.ts) and Modal reports it from
  // manager.py. It stays.
  //
  // If this assertion fails because a member was added, make sure something
  // actually writes it before widening the union.
  it("contains only states some code path can produce", () => {
    expect(sandboxStatusSchema.options).toEqual([
      "pending",
      "spawning",
      "connecting",
      "warming",
      "ready",
      "stale",
      "snapshotting",
      "stopped",
      "failed",
    ]);
  });

  it("rejects the removed dead states", () => {
    expect(sandboxStatusSchema.safeParse("syncing").success).toBe(false);
    expect(sandboxStatusSchema.safeParse("running").success).toBe(false);
  });
});
