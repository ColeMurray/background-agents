import { describe, expect, it } from "vitest";
import { piAgentEventIdentity, piProjectionIdentity } from "./projection-identity";

describe("piProjectionIdentity", () => {
  it("keeps streaming versions on one canonical display identity", () => {
    const base = {
      type: "token" as const,
      sandboxId: "pi:session-1",
      timestamp: 1,
      messageId: "message-1",
      partId: "message-1",
    };
    expect(piProjectionIdentity("message-1", { ...base, content: "a" })).toBe(
      piProjectionIdentity("message-1", { ...base, content: "answer" })
    );
  });

  it("uses distinct Pi task identities for separate compactions", () => {
    const event = {
      type: "context_compacted" as const,
      sandboxId: "pi:session-1",
      timestamp: 1,
      messageId: "message-1",
    };
    const firstSource = piAgentEventIdentity({
      type: "compaction_end",
      taskId: 1 as never,
      reason: "threshold",
    });
    const secondSource = piAgentEventIdentity({
      type: "compaction_end",
      taskId: 2 as never,
      reason: "threshold",
    });
    expect(piProjectionIdentity("message-1", event, firstSource)).not.toBe(
      piProjectionIdentity("message-1", event, secondSource)
    );
  });
});
