import { sandboxEventSchema } from "@open-inspect/shared/types/sandbox-events";
import { describe, expect, it } from "vitest";
import {
  generateTimelinePerformanceFixture,
  LARGE_SESSION_EVENT_COUNT,
  summarizeTimelinePerformanceFixture,
} from "./timeline-performance-fixture";

describe("generateTimelinePerformanceFixture", () => {
  it("generates the default 100,000 events exactly", () => {
    expect(LARGE_SESSION_EVENT_COUNT).toBe(100_000);
    expect(generateTimelinePerformanceFixture()).toHaveLength(100_000);
  });

  it("honors caller-specified counts", () => {
    expect(generateTimelinePerformanceFixture(0)).toEqual([]);
    expect(generateTimelinePerformanceFixture(37)).toHaveLength(37);
    expect(() => generateTimelinePerformanceFixture(-1)).toThrow(RangeError);
    expect(() => generateTimelinePerformanceFixture(1.5)).toThrow(RangeError);
  });

  it("is deterministic", () => {
    expect(generateTimelinePerformanceFixture(128)).toEqual(
      generateTimelinePerformanceFixture(128)
    );
  });

  it("generates schema-valid events across representative turns", () => {
    const events = generateTimelinePerformanceFixture(160);

    for (const event of events) {
      expect(sandboxEventSchema.safeParse(event).success).toBe(true);
    }
  });

  it("includes completed turns, Markdown, tools with outputs, warnings, and artifacts", () => {
    const events = generateTimelinePerformanceFixture(16);
    const types = new Set(events.map((event) => event.type));

    expect(types).toEqual(
      new Set([
        "user_message",
        "step_start",
        "token",
        "tool_call",
        "tool_result",
        "warning",
        "artifact",
        "step_finish",
        "execution_complete",
        "heartbeat",
        "git_sync",
        "context_compacted",
      ])
    );
    expect(events.find((event) => event.type === "token")?.content).toContain("## Turn");
    expect(
      events.filter((event) => event.type === "tool_call").every((event) => event.output)
    ).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "execution_complete", success: true })
    );
  });
});

describe("summarizeTimelinePerformanceFixture", () => {
  it("summarizes type counts and approximate serialized size", () => {
    const events = generateTimelinePerformanceFixture(16);
    const summary = summarizeTimelinePerformanceFixture(events);

    expect(summary).toEqual({
      eventCount: 16,
      byType: {
        user_message: 1,
        step_start: 1,
        token: 3,
        tool_call: 2,
        tool_result: 2,
        warning: 1,
        artifact: 1,
        step_finish: 1,
        execution_complete: 1,
        heartbeat: 1,
        git_sync: 1,
        context_compacted: 1,
      },
      approximateJsonBytes: JSON.stringify(events).length,
    });
  });
});
