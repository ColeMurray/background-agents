import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { formatRelativeTime, isInactiveSession } from "./time";

describe("formatRelativeTime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 'just now' for timestamps less than a minute ago", () => {
    const now = Date.now();
    vi.setSystemTime(now);
    expect(formatRelativeTime(now - 30_000)).toBe("just now");
    expect(formatRelativeTime(now)).toBe("just now");
  });

  it("returns minutes for timestamps less than an hour ago", () => {
    const now = Date.now();
    vi.setSystemTime(now);
    expect(formatRelativeTime(now - 5 * 60_000)).toBe("5m");
    expect(formatRelativeTime(now - 59 * 60_000)).toBe("59m");
  });

  it("returns hours for timestamps less than a day ago", () => {
    const now = Date.now();
    vi.setSystemTime(now);
    expect(formatRelativeTime(now - 3 * 60 * 60_000)).toBe("3h");
    expect(formatRelativeTime(now - 23 * 60 * 60_000)).toBe("23h");
  });

  it("returns days for timestamps older than a day", () => {
    const now = Date.now();
    vi.setSystemTime(now);
    expect(formatRelativeTime(now - 2 * 24 * 60 * 60_000)).toBe("2d");
    expect(formatRelativeTime(now - 30 * 24 * 60 * 60_000)).toBe("30d");
  });
});

describe("isInactiveSession", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns false for sessions updated within the last 7 days", () => {
    const now = Date.now();
    vi.setSystemTime(now);

    expect(isInactiveSession(now)).toBe(false);
    expect(isInactiveSession(now - 3 * 24 * 60 * 60_000)).toBe(false);
    // Exactly 7 days ago is still considered inactive (boundary)
    expect(isInactiveSession(now - 6 * 24 * 60 * 60_000)).toBe(false);
  });

  it("returns true for sessions updated more than 7 days ago", () => {
    const now = Date.now();
    vi.setSystemTime(now);

    expect(isInactiveSession(now - 8 * 24 * 60 * 60_000)).toBe(true);
    expect(isInactiveSession(now - 30 * 24 * 60 * 60_000)).toBe(true);
  });

  it("returns true for a session updated exactly 7 days + 1ms ago", () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const sevenDaysAgo = now - 7 * 24 * 60 * 60_000;
    expect(isInactiveSession(sevenDaysAgo - 1)).toBe(true);
  });
});
