import { describe, expect, it } from "vitest";
import { orphanedPromptReason, runtimeBoundaries } from "./orphaned-prompt";

const boundaries = { instanceReservedAt: 10_000, socketAttachedAt: 25_000 };
const prompt = (startedAt: number | null) => ({ id: "msg-1", started_at: startedAt });

describe("orphanedPromptReason", () => {
  it("fails a prompt dispatched before the instance was reserved, report or not", () => {
    expect(orphanedPromptReason(prompt(9_999), boundaries)).toBe("sandbox_replaced");
    expect(orphanedPromptReason(prompt(9_999), boundaries, { owedMessageId: "msg-1" })).toBe(
      "sandbox_replaced"
    );
  });

  it("fails a prompt the report does not name, dispatched before the socket attached", () => {
    expect(orphanedPromptReason(prompt(24_999), boundaries, { owedMessageId: null })).toBe(
      "runtime_restarted"
    );
    expect(orphanedPromptReason(prompt(24_999), boundaries, { owedMessageId: "msg-2" })).toBe(
      "runtime_restarted"
    );
  });

  it.each([
    ["the report names it", prompt(24_999), boundaries, { owedMessageId: "msg-1" }],
    ["there is no report", prompt(24_999), boundaries, undefined],
    [
      "it was dispatched on the current socket",
      prompt(25_000),
      boundaries,
      { owedMessageId: null },
    ],
    ["its dispatch time is unknown", prompt(null), boundaries, { owedMessageId: null }],
    [
      "no boundary was recorded",
      prompt(1),
      { instanceReservedAt: null, socketAttachedAt: null },
      { owedMessageId: null },
    ],
  ] as const)("keeps the prompt when %s", (_case, processing, at, report) => {
    expect(orphanedPromptReason(processing, at, report)).toBeNull();
  });
});

describe("runtimeBoundaries", () => {
  it("reads both boundaries from the sandbox row, and none without one", () => {
    expect(
      runtimeBoundaries({ instance_reserved_at: 10_000, active_socket_attached_at: 25_000 })
    ).toEqual(boundaries);
    expect(runtimeBoundaries(null)).toEqual({ instanceReservedAt: null, socketAttachedAt: null });
  });
});
