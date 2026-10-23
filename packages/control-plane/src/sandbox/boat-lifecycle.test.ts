import { describe, expect, it, vi } from "vitest";
import {
  assertBoatEnvWithinLimits,
  BOAT_LAUNCH_MARKER_PATH,
  BOAT_LAUNCHER_PATH,
  BOAT_SETUP_SCRIPT,
  BOAT_TUNNEL_ENV_FILE_PATH,
  BoatSandboxLifecycle,
  boatIdempotencyKey,
  resolveBoatMachineType,
  resolveBoatTtlSeconds,
} from "./boat-lifecycle";
import { BoatApiError, BoatNotFoundError } from "./boat-rest-client";
import { SandboxProviderError } from "./provider";
import { boatSandbox, fastTimings, mockClient } from "./providers/boat-provider.test-helpers";

describe("BoatSandboxLifecycle archive", () => {
  it("answers with what Boat did, never with a reading of the clock", async () => {
    const archived = mockClient({
      getSandbox: vi.fn(async () =>
        boatSandbox({
          state: "archived",
          snapshotAvailable: true,
          stop: { id: "stop_1", status: "completed" },
        })
      ),
    });
    await expect(
      new BoatSandboxLifecycle(archived, fastTimings).archive("bx_abcdefgh")
    ).resolves.toEqual({ type: "archived" });
    expect(archived.stopSandbox).toHaveBeenCalledWith("bx_abcdefgh", expect.any(AbortSignal));

    // An archive that outlasts the budget is still Boat's to finish, whether
    // the deadline passed or the caller gave up.
    const slow = mockClient({
      getSandbox: vi.fn(async () =>
        boatSandbox({ state: "archiving", stop: { id: "stop_1", status: "pending" } })
      ),
    });
    await expect(
      new BoatSandboxLifecycle(slow, fastTimings).archive("bx_abcdefgh", {
        deadlineAtMs: Date.now() + 20,
      })
    ).resolves.toEqual({ type: "timed_out" });
    await expect(
      new BoatSandboxLifecycle(slow, fastTimings).archive("bx_abcdefgh", {
        signal: AbortSignal.abort(),
      })
    ).resolves.toEqual({ type: "timed_out" });

    const gone = mockClient({
      stopSandbox: vi.fn(async () => {
        throw new BoatNotFoundError("gone");
      }),
    });
    await expect(
      new BoatSandboxLifecycle(gone, fastTimings).archive("bx_abcdefgh")
    ).resolves.toEqual({ type: "missing" });

    const unusable = mockClient({
      getSandbox: vi.fn(async () =>
        boatSandbox({
          state: "archived",
          snapshotAvailable: false,
          stop: { id: "stop_1", status: "failing", error: "disk busy" },
        })
      ),
    });
    await expect(
      new BoatSandboxLifecycle(unusable, fastTimings).archive("bx_abcdefgh")
    ).resolves.toMatchObject({ type: "unusable", detail: expect.stringContaining("disk busy") });
  });

  it("lets a call Boat refused through for the caller to classify", async () => {
    const refused = mockClient({
      stopSandbox: vi.fn(async () => {
        throw new BoatApiError("forbidden", 403);
      }),
    });
    await expect(
      new BoatSandboxLifecycle(refused, fastTimings).archive("bx_abcdefgh")
    ).rejects.toBeInstanceOf(BoatApiError);
  });
});

describe("BOAT_SETUP_SCRIPT", () => {
  it("waits for the launch marker as long as it takes, then execs the launcher", () => {
    const wait = BOAT_SETUP_SCRIPT.indexOf(
      `until [ -f ${BOAT_LAUNCH_MARKER_PATH} ]; do sleep 0.2; done`
    );
    const exec = BOAT_SETUP_SCRIPT.indexOf(`exec ${BOAT_LAUNCHER_PATH}`);
    expect(wait).toBeGreaterThan(-1);
    expect(exec).toBeGreaterThan(wait);
    // No deadline of its own: one could expire while a create is still
    // completing its retries, and a sandbox whose create fails is deleted.
    expect(BOAT_SETUP_SCRIPT).not.toContain("exit 1");
    // Under /tmp, which no Boat snapshot keeps: no image or restored disk can
    // carry a marker that would let a launch outrun this side.
    expect(BOAT_LAUNCH_MARKER_PATH.startsWith("/tmp/")).toBe(true);
    // Nothing is copied: the control plane writes the tunnel env file in place.
    expect(BOAT_SETUP_SCRIPT).not.toContain("cp ");
    expect(BOAT_TUNNEL_ENV_FILE_PATH).toBe("/home/user/workspace/.tunnels.env");
  });
});

describe("resolveBoatMachineType", () => {
  it("returns the fallback when nothing is requested", () => {
    expect(resolveBoatMachineType(undefined, "default")).toBe("default");
    expect(resolveBoatMachineType({ cpuCores: null, memoryMib: null }, "small")).toBe("small");
  });

  it("picks the smallest size satisfying both dimensions", () => {
    expect(resolveBoatMachineType({ cpuCores: 1 }, "default")).toBe("small");
    expect(resolveBoatMachineType({ memoryMib: 5000 }, "small")).toBe("default");
    expect(resolveBoatMachineType({ cpuCores: 2, memoryMib: 16384 }, "small")).toBe("large");
    expect(resolveBoatMachineType({ cpuCores: 16 }, "small")).toBe("xlarge");
  });

  it("rejects a request no size can satisfy", () => {
    expect(() => resolveBoatMachineType({ cpuCores: 32 }, "default")).toThrow(SandboxProviderError);
    expect(() => resolveBoatMachineType({ memoryMib: 65536 }, "default")).toThrow(
      /exceed the largest Boat machine type/
    );
  });
});

describe("resolveBoatTtlSeconds", () => {
  it("defaults, rounds and clamps to Boat's bounds", () => {
    expect(resolveBoatTtlSeconds(undefined)).toBe(7200);
    expect(resolveBoatTtlSeconds(90.4)).toBe(90);
    expect(resolveBoatTtlSeconds(0)).toBe(1);
    expect(resolveBoatTtlSeconds(99_999_999)).toBe(2_592_000);
  });
});

describe("assertBoatEnvWithinLimits", () => {
  it("accepts an ordinary env", () => {
    expect(() => assertBoatEnvWithinLimits({ A: "1", _b2: "x".repeat(1000) })).not.toThrow();
  });

  it("names invalid keys without their values", () => {
    expect(() => assertBoatEnvWithinLimits({ "BAD-KEY": "secret-value" })).toThrow(
      /BAD-KEY(?!.*secret-value)/
    );
  });

  it("enforces the variable count and total size", () => {
    const many = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`K${i}`, "v"]));
    expect(() => assertBoatEnvWithinLimits(many)).toThrow(/101 variables/);
    expect(() => assertBoatEnvWithinLimits({ BIG: "x".repeat(64 * 1024) })).toThrow(/bytes/);
  });
});

describe("boatIdempotencyKey", () => {
  it("is deterministic per deployment, session and sandbox, and distinct across them", async () => {
    const key = await boatIdempotencyKey("prod", "sess-a", "sb-1");
    expect(key).toMatch(/^openinspect-[a-f0-9]{64}$/);
    expect(await boatIdempotencyKey("prod", "sess-a", "sb-1")).toBe(key);
    expect(await boatIdempotencyKey("staging", "sess-a", "sb-1")).not.toBe(key);
    expect(await boatIdempotencyKey("prod", "sess-a", "sb-2")).not.toBe(key);
    expect(await boatIdempotencyKey("prod", "sess-b", "sb-1")).not.toBe(key);
  });
});
