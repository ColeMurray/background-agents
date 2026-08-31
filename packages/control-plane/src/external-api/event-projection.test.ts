import { describe, expect, it } from "vitest";
import { projectExternalEventPage } from "./event-projection";

describe("external event projection", () => {
  it("preserves legitimate token fields while removing exact credential fields", () => {
    expect(
      projectExternalEventPage({
        changes: [
          {
            kind: "upsert",
            revision: 1,
            event: {
              id: "event-1",
              type: "tool_call",
              messageId: "message-1",
              createdAt: 1,
              data: {
                type: "tool_call",
                sandboxId: "sandbox-identity",
                timestamp: 1,
                messageId: "message-1",
                tool: "shell",
                callId: "call-1",
                args: {
                  command: "deploy",
                  authorization: "Bearer secret",
                  tokenCount: 12,
                  nested: { accessToken: "secret", safe: "visible" },
                },
                scmTokenEncrypted: "ciphertext",
              },
            },
          },
        ],
        checkpoint: 1,
        hasMore: false,
      })
    ).toEqual({
      changes: [
        {
          kind: "upsert",
          revision: 1,
          event: {
            id: "event-1",
            type: "tool_call",
            messageId: "message-1",
            createdAt: 1,
            data: {
              type: "tool_call",
              timestamp: 1,
              messageId: "message-1",
              tool: "shell",
              callId: "call-1",
              args: { command: "deploy", tokenCount: 12, nested: { safe: "visible" } },
            },
          },
        },
      ],
      checkpoint: 1,
      hasMore: false,
    });
  });

  it("redacts managed secret values from every projected string", () => {
    const tokenPage = projectExternalEventPage(
      {
        changes: [
          {
            kind: "upsert",
            revision: 1,
            event: {
              id: "event-1",
              type: "token",
              messageId: "message-1",
              createdAt: 1,
              data: {
                type: "token",
                sandboxId: "sandbox-1",
                timestamp: 1,
                messageId: "message-1",
                content: "exact-secret",
              },
            },
          },
        ],
        checkpoint: 1,
        hasMore: false,
      },
      new Set(["exact-secret"])
    );
    expect(tokenPage.changes[0]).toMatchObject({ kind: "upsert" });
    if (tokenPage.changes[0].kind !== "upsert") throw new Error("Expected upsert");
    expect(tokenPage.changes[0].event.data).toEqual({
      type: "token",
      timestamp: 1,
      messageId: "message-1",
      content: "[REDACTED]",
    });

    const errorPage = projectExternalEventPage(
      {
        changes: [
          {
            kind: "upsert",
            revision: 1,
            event: {
              id: "event-1",
              type: "error",
              messageId: "message-1",
              createdAt: 1,
              data: {
                type: "error",
                sandboxId: "sandbox-1",
                timestamp: 1,
                messageId: "message-1",
                error: "prefix exact-secret suffix",
              },
            },
          },
        ],
        checkpoint: 1,
        hasMore: false,
      },
      new Set(["exact-secret"])
    );
    if (errorPage.changes[0].kind !== "upsert") throw new Error("Expected upsert");
    expect(errorPage.changes[0].event.data.error).toBe("prefix [REDACTED] suffix");

    expect(
      projectExternalEventPage(
        {
          changes: [{ kind: "delete", revision: 2, eventId: "event-exact-secret" }],
          checkpoint: 2,
          hasMore: false,
        },
        new Set(["exact-secret"])
      ).changes[0]
    ).toEqual({ kind: "delete", revision: 2, eventId: "event-[REDACTED]" });
  });
});
