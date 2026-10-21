import { describe, expect, it } from "vitest";
import {
  piRuntimeControlSchema,
  piRuntimeOperationStatusSchema,
  toPiModel,
  toPiThinkingLevel,
} from "../pi/runtime-contract";

describe("Pi runtime contract", () => {
  it("bounds native controls and requires exact cancellation targets", () => {
    expect(
      piRuntimeControlSchema.safeParse({
        sessionId: "s",
        requestId: "r",
        action: "follow_up",
        content: "x".repeat(20_001),
      }).success
    ).toBe(false);
    expect(
      piRuntimeControlSchema.safeParse({ sessionId: "s", requestId: "r", action: "cancel_exact" })
        .success
    ).toBe(false);
    expect(
      piRuntimeControlSchema.safeParse({
        sessionId: "s",
        requestId: "r",
        action: "cancel_exact",
        taskId: 1,
      }).success
    ).toBe(true);
  });
  it("maps Open-Inspect OpenAI model ids to Pi's Codex provider", () => {
    expect(toPiModel("openai/gpt-6.1-sol")).toEqual({
      provider: "openai-codex",
      id: "gpt-6.1-sol",
    });
    expect(toPiModel("gpt-5.5")).toEqual({ provider: "openai-codex", id: "gpt-5.5" });
  });

  it("refuses models outside the Codex subscription provider", () => {
    expect(() => toPiModel("anthropic/claude-sonnet-4-6")).toThrow(
      "Pi Durable requires an OpenAI model"
    );
  });

  it("preserves supported Pi thinking levels and omits absent values", () => {
    expect(toPiThinkingLevel("xhigh")).toBe("xhigh");
    expect(toPiThinkingLevel("max")).toBe("max");
    expect(toPiThinkingLevel(undefined)).toBeUndefined();
    expect(() => toPiThinkingLevel("ultra")).toThrow("Unsupported Pi thinking level");
  });

  it("requires terminal data only for settled operation lookups", () => {
    expect(piRuntimeOperationStatusSchema.parse({ status: "not_found" })).toEqual({
      status: "not_found",
    });
    expect(piRuntimeOperationStatusSchema.parse({ status: "queued" })).toEqual({
      status: "queued",
    });
    expect(piRuntimeOperationStatusSchema.parse({ status: "running" })).toEqual({
      status: "running",
    });
    expect(() => piRuntimeOperationStatusSchema.parse({ status: "settled" })).toThrow();
    expect(
      piRuntimeOperationStatusSchema.parse({
        status: "settled",
        result: {
          operationId: "message-1",
          status: "done",
          text: "answer",
          usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
          costUsd: 0.000025,
        },
      })
    ).toMatchObject({ status: "settled", result: { operationId: "message-1" } });
  });
});
