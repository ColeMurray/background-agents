import { describe, expect, it, vi } from "vitest";
import { createVncAccess, providerResumesAfterStop, signalUntilDeadline } from "./provider";

describe("providerResumesAfterStop", () => {
  it.each([
    [true, true, true, true],
    [true, true, false, false],
    [true, false, true, false],
    [true, false, false, false],
    [false, true, true, false],
    [false, true, false, false],
    [false, false, true, false],
    [false, false, false, false],
    [undefined, true, true, false],
    [true, true, undefined, false],
  ])(
    "requires explicit stop (%s), a stop method (%s), and persistent resume (%s)",
    (explicitStop, hasStop, persistentResume, expected) => {
      const stopSandbox = vi.fn(async () => ({ success: true }));
      expect(
        providerResumesAfterStop({
          capabilities: {
            supportsSandboxTimeout: false,
            supportsSnapshots: false,
            supportsRestore: false,
            supportsExplicitStop: explicitStop,
            supportsPersistentResume: persistentResume,
          },
          stopSandbox: hasStop ? stopSandbox : undefined,
        })
      ).toBe(expected);
      expect(stopSandbox).not.toHaveBeenCalled();
    }
  );
});

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
