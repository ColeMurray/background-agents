import { describe, expect, it, vi } from "vitest";
import { armTurnDeadline } from "./turn-deadline";

/**
 * The turn's deadline, inside the Durable Object.
 *
 * Remove the deadline and a turn that never finishes holds the object
 * forever: that is what the last two cases prove.
 */
describe("the turn deadline", () => {
  it("expires when the deadline passes", () => {
    let clock = 1_000;
    const onExpire = vi.fn();
    const timers = {
      set: vi.fn((handler: () => void, delayMs: number) => {
        expect(delayMs).toBe(500);
        clock += delayMs;
        handler();
        return 1;
      }),
      clear: vi.fn(),
    };

    const deadline = armTurnDeadline({
      deadlineMs: 1_500,
      onExpire,
      now: () => clock,
      timers,
    });

    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(deadline.expired).toBe(true);
    expect(deadline.remainingMs).toBe(0);
  });

  it("expires at once when the deadline has already passed", () => {
    const onExpire = vi.fn();
    const timers = { set: vi.fn(), clear: vi.fn() };

    const deadline = armTurnDeadline({
      deadlineMs: 500,
      onExpire,
      now: () => 1_000,
      timers,
    });

    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(deadline.expired).toBe(true);
    // A turn that is already late is not given a timer at all.
    expect(timers.set).not.toHaveBeenCalled();
  });

  it("does not expire while the turn finishes in time", () => {
    const onExpire = vi.fn();
    const timers = { set: vi.fn(() => 1), clear: vi.fn() };

    const deadline = armTurnDeadline({
      deadlineMs: 10_000,
      onExpire,
      now: () => 1_000,
      timers,
    });

    expect(deadline.expired).toBe(false);
    expect(deadline.remainingMs).toBe(9_000);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it("is cancelled when the turn finishes before it is late", () => {
    const onExpire = vi.fn();
    const timers = { set: vi.fn(() => 7), clear: vi.fn() };

    const deadline = armTurnDeadline({
      deadlineMs: 10_000,
      onExpire,
      now: () => 1_000,
      timers,
    });
    deadline.clear();

    expect(timers.clear).toHaveBeenCalledWith(7);
    expect(deadline.expired).toBe(false);
  });

  it("does not expire twice", () => {
    let clock = 1_000;
    const onExpire = vi.fn();
    const timers = {
      set: vi.fn((handler: () => void, delayMs: number) => {
        clock += delayMs;
        handler();
        handler();
        return 1;
      }),
      clear: vi.fn(),
    };

    armTurnDeadline({ deadlineMs: 1_500, onExpire, now: () => clock, timers });

    expect(onExpire).toHaveBeenCalledTimes(1);
  });
});
