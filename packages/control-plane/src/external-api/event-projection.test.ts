import { describe, expect, it } from "vitest";
import { projectExternalEventPage } from "./event-projection";

function page(type: string, data: Record<string, unknown>) {
  return {
    changes: [
      {
        kind: "upsert",
        revision: 1,
        event: { id: "event-1", type, messageId: "message-1", createdAt: 1, data },
      },
    ],
    checkpoint: 1,
    hasMore: false,
  };
}

describe("external event projection", () => {
  it("emits only fixed safe tool-call metadata", () => {
    const projected = projectExternalEventPage(
      page("tool_call", {
        type: "tool_call",
        sandboxId: "sandbox-identity",
        timestamp: 1,
        messageId: "message-1",
        tool: "shell",
        callId: "call-1",
        status: "running",
        isSubtask: true,
        childSessionId: "child-1",
        args: { command: "deploy", authorization: "historical-secret" },
        output: "rotated-secret",
      })
    );

    expect(projected.changes[0]).toMatchObject({
      kind: "upsert",
      event: {
        data: { type: "tool_call", timestamp: 1, status: "running", isSubtask: true },
      },
    });
    expect(JSON.stringify(projected)).not.toContain("historical-secret");
    expect(JSON.stringify(projected)).not.toContain("rotated-secret");
    expect(JSON.stringify(projected)).not.toContain("sandbox-identity");
  });

  it.each([
    ["token", { content: "deleted-global-secret" }],
    ["tool_result", { callId: "call-1", result: "non-global-secret", error: "secret-error" }],
    ["error", { error: "historical-secret" }],
    ["execution_complete", { success: false, error: "rotated-secret" }],
    ["push_error", { error: "deleted-global-secret" }],
    ["warning", { scope: "secrets", message: "non-global-secret" }],
    ["session_title", { title: "historical-secret" }],
    ["user_message", { content: "rotated-secret" }],
  ])("never exposes free-form strings from %s events", (type, fields) => {
    const projected = projectExternalEventPage(
      page(type, {
        type,
        timestamp: 1,
        sandboxId: "sandbox-1",
        messageId: "message-1",
        ...fields,
      })
    );
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain("historical-secret");
    expect(serialized).not.toContain("rotated-secret");
    expect(serialized).not.toContain("deleted-global-secret");
    expect(serialized).not.toContain("non-global-secret");
    expect(serialized).not.toContain("secret-error");
  });

  it("preserves numeric usage, fixed statuses, and tombstones", () => {
    const finish = projectExternalEventPage(
      page("step_finish", {
        type: "step_finish",
        sandboxId: "sandbox-1",
        timestamp: 4,
        messageId: "message-1",
        cost: 0.25,
        tokens: {
          total: 20,
          input: 12,
          output: 8,
          cache: { read: 3, providerSecret: "never" },
          providerSecret: "never",
        },
        reason: "contains-secret",
      })
    );
    if (finish.changes[0].kind !== "upsert") throw new Error("Expected upsert");
    expect(finish.changes[0].event.data).toEqual({
      type: "step_finish",
      timestamp: 4,
      cost: 0.25,
      tokens: { total: 20, input: 12, output: 8, cache: { read: 3 } },
    });

    expect(
      projectExternalEventPage({
        changes: [{ kind: "delete", revision: 2, eventId: "event-1" }],
        checkpoint: 2,
        hasMore: false,
      }).changes[0]
    ).toEqual({ kind: "delete", revision: 2, eventId: "event-1" });
  });
});
