import { describe, expect, it } from "vitest";
import { createVncAccess, signalUntilDeadline } from "./provider";

describe("createVncAccess", () => {
  it("returns only complete VNC credentials", () => {
    expect(createVncAccess("https://vnc.test", "secret")).toEqual({
      url: "https://vnc.test",
      password: "secret",
    });
    expect(createVncAccess("https://vnc.test", undefined)).toBeUndefined();
    expect(createVncAccess(undefined, "secret")).toBeUndefined();
  });
});

describe("signalUntilDeadline", () => {
  it("returns an already-aborted signal for an expired absolute deadline", () => {
    const signal = signalUntilDeadline(Date.now() - 1);
    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toMatchObject({ name: "TimeoutError" });
  });

  it("preserves caller cancellation while applying a future deadline", () => {
    const caller = new AbortController();
    const signal = signalUntilDeadline(Date.now() + 60_000, caller.signal);
    caller.abort("cancelled");
    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toBe("cancelled");
  });
});
