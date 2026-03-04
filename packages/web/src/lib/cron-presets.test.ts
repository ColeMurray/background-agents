import { describe, expect, it } from "vitest";
import { detectPreset, buildCron } from "./cron-presets";

describe("detectPreset", () => {
  it("detects hourly (0 * * * *)", () => {
    expect(detectPreset("0 * * * *")).toEqual({
      type: "hourly",
      hour: 9,
      dayOfWeek: "1",
      dayOfMonth: 1,
    });
  });

  it("detects daily (0 14 * * *)", () => {
    expect(detectPreset("0 14 * * *")).toEqual({
      type: "daily",
      hour: 14,
      dayOfWeek: "1",
      dayOfMonth: 1,
    });
  });

  it("detects weekly (0 9 * * 3)", () => {
    expect(detectPreset("0 9 * * 3")).toEqual({
      type: "weekly",
      hour: 9,
      dayOfWeek: "3",
      dayOfMonth: 1,
    });
  });

  it("detects monthly (0 9 15 * *)", () => {
    expect(detectPreset("0 9 15 * *")).toEqual({
      type: "monthly",
      hour: 9,
      dayOfWeek: "1",
      dayOfMonth: 15,
    });
  });

  it("rejects monthly with day > 28 as custom", () => {
    expect(detectPreset("0 9 31 * *").type).toBe("custom");
  });

  it("returns custom for complex expressions", () => {
    expect(detectPreset("*/15 * * * *").type).toBe("custom");
    expect(detectPreset("0 9 * * 1-5").type).toBe("custom");
    expect(detectPreset("0 9 1,15 * *").type).toBe("custom");
  });

  it("returns custom for invalid expressions", () => {
    expect(detectPreset("not a cron").type).toBe("custom");
    expect(detectPreset("0 * * *").type).toBe("custom"); // 4-field
    expect(detectPreset("0 0 0 * * *").type).toBe("custom"); // 6-field
  });

  it("handles midnight (hour 0)", () => {
    expect(detectPreset("0 0 * * *")).toEqual({
      type: "daily",
      hour: 0,
      dayOfWeek: "1",
      dayOfMonth: 1,
    });
  });

  it("handles Sunday (day 0) for weekly", () => {
    expect(detectPreset("0 10 * * 0")).toEqual({
      type: "weekly",
      hour: 10,
      dayOfWeek: "0",
      dayOfMonth: 1,
    });
  });
});

describe("buildCron", () => {
  it("builds hourly", () => {
    expect(buildCron("hourly", 9, "1", 1)).toBe("0 * * * *");
  });

  it("builds daily at specified hour", () => {
    expect(buildCron("daily", 14, "1", 1)).toBe("0 14 * * *");
  });

  it("builds weekly at specified day and hour", () => {
    expect(buildCron("weekly", 9, "3", 1)).toBe("0 9 * * 3");
  });

  it("builds monthly at specified day and hour", () => {
    expect(buildCron("monthly", 9, "1", 15)).toBe("0 9 15 * *");
  });

  it("returns empty string for custom", () => {
    expect(buildCron("custom", 9, "1", 1)).toBe("");
  });
});

describe("detectPreset/buildCron roundtrip", () => {
  const cases = [
    { type: "hourly" as const, hour: 9, dayOfWeek: "1", dayOfMonth: 1 },
    { type: "daily" as const, hour: 14, dayOfWeek: "1", dayOfMonth: 1 },
    { type: "weekly" as const, hour: 9, dayOfWeek: "5", dayOfMonth: 1 },
    { type: "monthly" as const, hour: 10, dayOfWeek: "1", dayOfMonth: 20 },
  ];

  for (const { type, hour, dayOfWeek, dayOfMonth } of cases) {
    it(`roundtrips ${type}`, () => {
      const cron = buildCron(type, hour, dayOfWeek, dayOfMonth);
      const detected = detectPreset(cron);
      expect(detected.type).toBe(type);
      if (type !== "hourly") {
        expect(detected.hour).toBe(hour);
      }
      if (type === "weekly") {
        expect(detected.dayOfWeek).toBe(dayOfWeek);
      }
      if (type === "monthly") {
        expect(detected.dayOfMonth).toBe(dayOfMonth);
      }
    });
  }
});
