import { describe, expect, it } from "vitest";
import {
  classifyThreadSpeaker,
  compareSlackTimestamps,
  selectThreadWindow,
} from "./thread-context";
import type { SlackThreadMessage } from "./client";

function message(ts: string, overrides: Partial<SlackThreadMessage> = {}): SlackThreadMessage {
  return { ts, text: `message ${ts}`, user: "U111", ...overrides };
}

describe("selectThreadWindow", () => {
  it("drops the triggering message", () => {
    const window = selectThreadWindow([message("1.000001"), message("2.000002")], {
      excludeTs: "2.000002",
      limit: 10,
    });
    expect(window.map((m) => m.ts)).toEqual(["1.000001"]);
  });

  it("enforces exact strict before and since boundaries", () => {
    // conversations.replies can return a reply posted between the trigger and
    // the fetch; showing it as prior context leaks later thread state.
    const window = selectThreadWindow(
      [
        message("1700000000.000001"),
        message("1700000000.000002"),
        message("1700000000.000003"),
        message("1700000000.000004"),
      ],
      {
        sinceTs: "1700000000.000001",
        excludeTs: "1700000000.000003",
        beforeTs: "1700000000.000003",
        limit: 10,
      }
    );
    expect(window.map((m) => m.ts)).toEqual(["1700000000.000002"]);
  });

  it("compares timestamps numerically, not lexically", () => {
    // "9.000000" > "10.000000" as strings but not as numbers.
    const window = selectThreadWindow([message("9.000000")], {
      beforeTs: "10.000000",
      limit: 10,
    });
    expect(window).toHaveLength(1);
  });

  it("keeps only messages strictly newer than sinceTs", () => {
    const window = selectThreadWindow(
      [message("1.000001"), message("2.000002"), message("3.000003")],
      { sinceTs: "2.000002", limit: 10 }
    );
    expect(window.map((m) => m.ts)).toEqual(["3.000003"]);
  });

  it("applies exclusions before the limit so dropped messages cost no slots", () => {
    const messages = [
      message("1.000001", { bot_id: "B1" }),
      message("2.000002"),
      message("3.000003"),
    ];
    const window = selectThreadWindow(messages, { excludeBots: true, limit: 2 });
    expect(window.map((m) => m.ts)).toEqual(["2.000002", "3.000003"]);
  });

  it("keeps the thread root when the tail limit would drop it", () => {
    const messages = Array.from({ length: 6 }, (_, i) => message(`${i + 1}.000000`));
    const window = selectThreadWindow(messages, { limit: 3, keepRootTs: "1.000000" });
    // Root survives; it takes the oldest tail slot rather than widening the window.
    expect(window.map((m) => m.ts)).toEqual(["1.000000", "5.000000", "6.000000"]);
  });

  it("does not duplicate the root when it is already inside the tail", () => {
    const messages = [message("1.000000"), message("2.000000")];
    const window = selectThreadWindow(messages, { limit: 5, keepRootTs: "1.000000" });
    expect(window.map((m) => m.ts)).toEqual(["1.000000", "2.000000"]);
  });

  it.each([0, -1])("returns no messages for a non-positive limit (%i)", (limit) => {
    expect(selectThreadWindow([message("1.000000")], { limit })).toEqual([]);
  });
});

describe("compareSlackTimestamps", () => {
  it("orders distinct fractional values exactly even beyond Number precision", () => {
    expect(
      compareSlackTimestamps("9999999999999999.000001", "9999999999999999.000002")
    ).toBeLessThan(0);
    expect(
      compareSlackTimestamps("9999999999999999.000002", "9999999999999999.000001")
    ).toBeGreaterThan(0);
  });

  it("treats equivalent decimal representations as equal", () => {
    expect(compareSlackTimestamps("00010.100", "10.1")).toBe(0);
  });
});

describe("classifyThreadSpeaker", () => {
  it("recognises the bot's own messages", () => {
    expect(classifyThreadSpeaker(message("1.0", { user: "UBOT" }), "UBOT")).toEqual({
      kind: "self",
    });
  });

  it("prefers bot_id over user so apps are never rendered as people", () => {
    // Slack sets both on app messages posted with a user identity.
    expect(classifyThreadSpeaker(message("1.0", { user: "U1", bot_id: "B42" }), "UBOT")).toEqual({
      kind: "app",
      id: "B42",
    });
  });

  it("classifies a person", () => {
    expect(classifyThreadSpeaker(message("1.0", { user: "U1" }), "UBOT")).toEqual({
      kind: "user",
      id: "U1",
    });
  });

  it("falls back to unknown with neither identity", () => {
    expect(classifyThreadSpeaker({ ts: "1.0", text: "x" }, "UBOT")).toEqual({ kind: "unknown" });
  });
});
