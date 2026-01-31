import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getEventCategory, shouldPersistEvent, TokenAggregator } from "./events";

describe("event utilities", () => {
  describe("getEventCategory", () => {
    it("categorizes execution events", () => {
      expect(getEventCategory("token")).toBe("execution");
      expect(getEventCategory("tool_call")).toBe("execution");
      expect(getEventCategory("tool_result")).toBe("execution");
      expect(getEventCategory("execution_complete")).toBe("execution");
    });

    it("categorizes git events", () => {
      expect(getEventCategory("git_sync")).toBe("git");
    });

    it("categorizes artifact events", () => {
      expect(getEventCategory("artifact")).toBe("artifact");
    });

    it("categorizes unknown events as system", () => {
      expect(getEventCategory("heartbeat")).toBe("system");
      expect(getEventCategory("error")).toBe("system");
      expect(getEventCategory("unknown_event")).toBe("system");
      expect(getEventCategory("")).toBe("system");
    });
  });

  describe("shouldPersistEvent", () => {
    it("returns false for heartbeat events", () => {
      expect(shouldPersistEvent("heartbeat")).toBe(false);
    });

    it("returns true for all other events", () => {
      expect(shouldPersistEvent("token")).toBe(true);
      expect(shouldPersistEvent("tool_call")).toBe(true);
      expect(shouldPersistEvent("tool_result")).toBe(true);
      expect(shouldPersistEvent("execution_complete")).toBe(true);
      expect(shouldPersistEvent("git_sync")).toBe(true);
      expect(shouldPersistEvent("artifact")).toBe(true);
      expect(shouldPersistEvent("error")).toBe(true);
      expect(shouldPersistEvent("unknown")).toBe(true);
    });
  });
});

describe("TokenAggregator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("flushes tokens after timeout", () => {
    const flushCallback = vi.fn();
    const aggregator = new TokenAggregator(50, 100);
    aggregator.onFlush(flushCallback);

    aggregator.add("Hello", "msg-1");
    aggregator.add(" ", "msg-1");
    aggregator.add("World", "msg-1");

    // Before timeout, callback not called
    expect(flushCallback).not.toHaveBeenCalled();

    // After timeout, tokens are flushed
    vi.advanceTimersByTime(50);
    expect(flushCallback).toHaveBeenCalledTimes(1);
    expect(flushCallback).toHaveBeenCalledWith("Hello World", "msg-1");
  });

  it("flushes when buffer reaches max size", () => {
    const flushCallback = vi.fn();
    const aggregator = new TokenAggregator(50, 5); // max 5 tokens
    aggregator.onFlush(flushCallback);

    // Add 5 tokens (should trigger flush)
    aggregator.add("a", "msg-1");
    aggregator.add("b", "msg-1");
    aggregator.add("c", "msg-1");
    aggregator.add("d", "msg-1");
    aggregator.add("e", "msg-1");

    expect(flushCallback).toHaveBeenCalledTimes(1);
    expect(flushCallback).toHaveBeenCalledWith("abcde", "msg-1");
  });

  it("flushes when message ID changes", () => {
    const flushCallback = vi.fn();
    const aggregator = new TokenAggregator(50, 100);
    aggregator.onFlush(flushCallback);

    aggregator.add("Hello", "msg-1");
    aggregator.add(" World", "msg-1");

    // Change message ID - should flush previous buffer
    aggregator.add("New", "msg-2");

    expect(flushCallback).toHaveBeenCalledTimes(1);
    expect(flushCallback).toHaveBeenCalledWith("Hello World", "msg-1");

    // Advance timer to flush the new message
    vi.advanceTimersByTime(50);
    expect(flushCallback).toHaveBeenCalledTimes(2);
    expect(flushCallback).toHaveBeenCalledWith("New", "msg-2");
  });

  it("concatenates tokens correctly", () => {
    const flushCallback = vi.fn();
    const aggregator = new TokenAggregator(50, 100);
    aggregator.onFlush(flushCallback);

    aggregator.add("The ", "msg-1");
    aggregator.add("quick ", "msg-1");
    aggregator.add("brown ", "msg-1");
    aggregator.add("fox", "msg-1");

    vi.advanceTimersByTime(50);
    expect(flushCallback).toHaveBeenCalledWith("The quick brown fox", "msg-1");
  });

  it("manual flush clears buffer and timer", () => {
    const flushCallback = vi.fn();
    const aggregator = new TokenAggregator(50, 100);
    aggregator.onFlush(flushCallback);

    aggregator.add("Hello", "msg-1");
    aggregator.flush();

    expect(flushCallback).toHaveBeenCalledTimes(1);
    expect(flushCallback).toHaveBeenCalledWith("Hello", "msg-1");

    // Advancing timers should not trigger another flush
    vi.advanceTimersByTime(100);
    expect(flushCallback).toHaveBeenCalledTimes(1);
  });

  it("flush does nothing when buffer is empty", () => {
    const flushCallback = vi.fn();
    const aggregator = new TokenAggregator(50, 100);
    aggregator.onFlush(flushCallback);

    aggregator.flush();
    expect(flushCallback).not.toHaveBeenCalled();
  });

  it("destroy flushes remaining tokens and clears callback", () => {
    const flushCallback = vi.fn();
    const aggregator = new TokenAggregator(50, 100);
    aggregator.onFlush(flushCallback);

    aggregator.add("Final", "msg-1");
    aggregator.destroy();

    expect(flushCallback).toHaveBeenCalledWith("Final", "msg-1");

    // After destroy, callback should be null so subsequent flushes do nothing
    aggregator.add("More", "msg-2");
    vi.advanceTimersByTime(50);
    expect(flushCallback).toHaveBeenCalledTimes(1); // Still only called once
  });

  it("handles multiple flush cycles", () => {
    const flushCallback = vi.fn();
    const aggregator = new TokenAggregator(50, 100);
    aggregator.onFlush(flushCallback);

    // First cycle
    aggregator.add("First", "msg-1");
    vi.advanceTimersByTime(50);
    expect(flushCallback).toHaveBeenNthCalledWith(1, "First", "msg-1");

    // Second cycle
    aggregator.add("Second", "msg-2");
    vi.advanceTimersByTime(50);
    expect(flushCallback).toHaveBeenNthCalledWith(2, "Second", "msg-2");

    expect(flushCallback).toHaveBeenCalledTimes(2);
  });

  it("uses default values when not specified", () => {
    const flushCallback = vi.fn();
    const aggregator = new TokenAggregator(); // default: 50ms, 100 tokens
    aggregator.onFlush(flushCallback);

    aggregator.add("test", "msg-1");

    // Default 50ms timeout
    vi.advanceTimersByTime(50);
    expect(flushCallback).toHaveBeenCalled();
  });
});
