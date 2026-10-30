import { describe, expect, it } from "vitest";
import { orphanedPromptReason } from "./orphaned-prompt";

describe("orphanedPromptReason", () => {
  const prompt = { id: "msg-1", started_at: 1_000 };

  it("fails a prompt the report does not hold when it predates the socket", () => {
    expect(orphanedPromptReason(prompt, 2_000, { owedMessageId: null })).toBe("runtime_restarted");
    expect(orphanedPromptReason(prompt, 2_000, { owedMessageId: "msg-other" })).toBe(
      "runtime_restarted"
    );
  });

  it("keeps the prompt the bridge names, one dispatched on this socket, and one without proof", () => {
    expect(orphanedPromptReason(prompt, 2_000, { owedMessageId: "msg-1" })).toBeNull();
    expect(orphanedPromptReason(prompt, 1_000, { owedMessageId: null })).toBeNull();
    expect(orphanedPromptReason(prompt, 500, { owedMessageId: null })).toBeNull();
    expect(
      orphanedPromptReason({ id: "msg-1", started_at: null }, 2_000, { owedMessageId: null })
    ).toBeNull();
    expect(orphanedPromptReason(prompt, null, { owedMessageId: null })).toBeNull();
    expect(orphanedPromptReason(prompt, 2_000)).toBeNull();
  });
});
