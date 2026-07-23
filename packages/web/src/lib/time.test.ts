import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatFutureRelativeTime, formatRelativeTime } from "./time";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-09T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("formatRelativeTime", () => {
  it("keeps formatting past timestamps without future-time wording", () => {
    expect(formatRelativeTime(Date.now() - 2 * 60 * 60 * 1000)).toBe("2h");
  });
});

describe("formatFutureRelativeTime", () => {
  it("formats a scheduled time in minutes", () => {
    expect(formatFutureRelativeTime(Date.now() + 5 * 60 * 1000)).toBe("in 5m");
  });

  it("formats a scheduled time in hours", () => {
    expect(formatFutureRelativeTime(Date.now() + 2 * 60 * 60 * 1000)).toBe("in 2h");
  });

  it("formats a scheduled time in days", () => {
    expect(formatFutureRelativeTime(Date.now() + 24 * 60 * 60 * 1000)).toBe("in 1d");
  });

  it("formats a scheduled time less than one minute away", () => {
    expect(formatFutureRelativeTime(Date.now() + 60 * 1000 - 1)).toBe("in <1m");
  });

  it("formats a scheduled time exactly one minute away", () => {
    expect(formatFutureRelativeTime(Date.now() + 60 * 1000)).toBe("in 1m");
  });
});
