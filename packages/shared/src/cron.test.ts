import { describe, it, expect } from "vitest";
import { isValidCron, nextCronOccurrence, describeCron, cronIntervalMinutes } from "./cron";

describe("isValidCron", () => {
  it("accepts valid 5-field expressions", () => {
    expect(isValidCron("*/15 * * * *")).toBe(true);
    expect(isValidCron("0 9 * * 1")).toBe(true);
    expect(isValidCron("0 0 1 * *")).toBe(true);
    expect(isValidCron("30 14 * * 1-5")).toBe(true);
  });

  it("rejects 6-field (seconds) expressions", () => {
    expect(isValidCron("0 */15 * * * *")).toBe(false);
  });

  it("rejects invalid expressions", () => {
    expect(isValidCron("invalid")).toBe(false);
    expect(isValidCron("60 * * * *")).toBe(false);
    expect(isValidCron("")).toBe(false);
  });
});

describe("nextCronOccurrence", () => {
  it("returns the next occurrence after a given date", () => {
    const after = new Date("2025-06-15T08:00:00Z");
    const next = nextCronOccurrence("0 9 * * *", "UTC", after);
    expect(next.getUTCHours()).toBe(9);
    expect(next.getUTCMinutes()).toBe(0);
    expect(next.getTime()).toBeGreaterThan(after.getTime());
  });

  it("handles timezone offsets", () => {
    const after = new Date("2025-06-15T00:00:00Z");
    // 9 AM US/Eastern = 13:00 UTC (EDT, -4h)
    const next = nextCronOccurrence("0 9 * * *", "America/New_York", after);
    expect(next.getUTCHours()).toBe(13);
  });

  it("returns future occurrence when after is past the daily trigger", () => {
    const after = new Date("2025-06-15T15:00:00Z");
    const next = nextCronOccurrence("0 9 * * *", "UTC", after);
    // Should be next day at 9 AM UTC
    expect(next.getUTCDate()).toBe(16);
    expect(next.getUTCHours()).toBe(9);
  });
});

describe("describeCron", () => {
  it("describes every N minutes", () => {
    expect(describeCron("*/15 * * * *", "UTC")).toBe("Every 15 minutes (UTC)");
  });

  it("describes hourly at specific minute", () => {
    expect(describeCron("30 * * * *", "UTC")).toBe("Every hour at :30 (UTC)");
  });

  it("describes daily at specific time", () => {
    expect(describeCron("0 9 * * *", "UTC")).toBe("Every day at 9:00 AM (UTC)");
    expect(describeCron("30 14 * * *", "America/New_York")).toBe(
      "Every day at 2:30 PM (America/New_York)"
    );
  });

  it("describes weekday schedule", () => {
    expect(describeCron("0 9 * * 1-5", "UTC")).toBe("Every weekday at 9:00 AM (UTC)");
  });

  it("describes specific day schedule", () => {
    expect(describeCron("0 9 * * 1", "UTC")).toBe("Every Monday at 9:00 AM (UTC)");
  });

  it("falls back to raw expression for complex patterns", () => {
    expect(describeCron("0 9 1,15 * *", "UTC")).toBe("0 9 1,15 * * (UTC)");
  });
});

describe("cronIntervalMinutes", () => {
  it("returns interval for fixed-interval expressions", () => {
    expect(cronIntervalMinutes("*/15 * * * *")).toBe(15);
    expect(cronIntervalMinutes("*/30 * * * *")).toBe(30);
    expect(cronIntervalMinutes("*/1 * * * *")).toBe(1);
  });

  it("returns 60 for hourly at fixed minute", () => {
    expect(cronIntervalMinutes("0 * * * *")).toBe(60);
    expect(cronIntervalMinutes("30 * * * *")).toBe(60);
  });

  it("returns the constant interval for weekly expressions", () => {
    // Weekly (every Monday at 9am) = 10080 minutes = 7 days
    expect(cronIntervalMinutes("0 9 * * 1")).toBe(10080);
  });

  it("returns null for variable-interval expressions", () => {
    // Monthly (1st at midnight) — months have different lengths
    expect(cronIntervalMinutes("0 0 1 * *")).toBeNull();
  });

  it("returns null for invalid expressions", () => {
    expect(cronIntervalMinutes("invalid")).toBeNull();
  });
});
