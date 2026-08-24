import { describe, it, expect, vi } from "vitest";
import type { SandboxProvider } from "../sandbox/provider";
import { createDeferredSandboxProvider } from "./components";

function realProvider(overrides: Partial<SandboxProvider> = {}): SandboxProvider {
  return {
    name: "fake",
    capabilities: {
      supportsSnapshots: true,
      supportsRestore: true,
      supportsPersistentResume: false,
      supportsExplicitStop: false,
      supportsSandboxTimeout: false,
    } as SandboxProvider["capabilities"],
    createSandbox: vi.fn(async () => ({ sandboxId: "sb-1", status: "pending" }) as never),
    takeSnapshot: vi.fn(async () => ({ success: true }) as never),
    ...overrides,
  };
}

describe("createDeferredSandboxProvider", () => {
  it("does not invoke the factory until a member is touched, then memoizes", () => {
    const create = vi.fn(() => realProvider());
    const deferred = createDeferredSandboxProvider(create);

    expect(create).not.toHaveBeenCalled();

    expect(deferred.name).toBe("fake");
    expect(deferred.capabilities.supportsSnapshots).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("surfaces the construction error at first touch, not at adapter creation", () => {
    const create = vi.fn((): SandboxProvider => {
      throw new Error("MODAL_API_SECRET and MODAL_WORKSPACE are required");
    });

    const deferred = createDeferredSandboxProvider(create);
    expect(create).not.toHaveBeenCalled();

    expect(() => deferred.capabilities).toThrow("MODAL_API_SECRET and MODAL_WORKSPACE");
    // A throwing factory is not latched: the next touch retries construction,
    // matching the retry the lazy getter used to provide.
    expect(() => deferred.name).toThrow("MODAL_API_SECRET and MODAL_WORKSPACE");
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("delegates calls to the single constructed provider", async () => {
    const provider = realProvider();
    const create = vi.fn(() => provider);
    const deferred = createDeferredSandboxProvider(create);

    await deferred.createSandbox({} as never);
    await deferred.takeSnapshot!({} as never);

    expect(provider.createSandbox).toHaveBeenCalledTimes(1);
    expect(provider.takeSnapshot).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("mirrors optional-method presence so capability probes stay truthful", () => {
    const withoutOptionals = createDeferredSandboxProvider(() =>
      realProvider({ takeSnapshot: undefined, restoreFromSnapshot: undefined })
    );
    const withOptionals = createDeferredSandboxProvider(() =>
      realProvider({ restoreFromSnapshot: vi.fn(async () => ({ success: true }) as never) })
    );

    // The lifecycle manager gates snapshot/restore/resume/stop on presence
    // checks like `!this.provider.takeSnapshot` — the adapter must not turn an
    // absent method into a present one.
    expect(withoutOptionals.takeSnapshot).toBeUndefined();
    expect(withoutOptionals.restoreFromSnapshot).toBeUndefined();
    expect(withoutOptionals.resumeSandbox).toBeUndefined();
    expect(withoutOptionals.stopSandbox).toBeUndefined();
    expect(withOptionals.restoreFromSnapshot).toBeTypeOf("function");
  });
});
