import { describe, expect, it, vi } from "vitest";
import { OAuthRefreshSingleFlight } from "./oauth-refresh-single-flight";

describe("OAuthRefreshSingleFlight", () => {
  it("coalesces the same refresh-token version within a scope", async () => {
    const coordinator = new OAuthRefreshSingleFlight<string>();
    let resolveRefresh!: (result: string) => void;
    const refresh = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveRefresh = resolve;
        })
    );

    const first = coordinator.run({ kind: "global" }, "refresh-v1", refresh);
    const second = coordinator.run({ kind: "global" }, "refresh-v1", refresh);
    resolveRefresh("access-v1");

    await expect(Promise.all([first, second])).resolves.toEqual(["access-v1", "access-v1"]);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("does not let an older refresh clear a newer token version", async () => {
    const coordinator = new OAuthRefreshSingleFlight<string>();
    let resolveOld!: (result: string) => void;
    let resolveNew!: (result: string) => void;
    const oldRefresh = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveOld = resolve;
        })
    );
    const newRefresh = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveNew = resolve;
        })
    );

    const oldResult = coordinator.run({ kind: "global" }, "refresh-v1", oldRefresh);
    const newResult = coordinator.run({ kind: "global" }, "refresh-v2", newRefresh);
    resolveOld("access-v1");
    await expect(oldResult).resolves.toBe("access-v1");

    const coalescedNewResult = coordinator.run(
      { kind: "global" },
      "refresh-v2",
      vi.fn().mockResolvedValue("unused")
    );
    resolveNew("access-v2");

    await expect(Promise.all([newResult, coalescedNewResult])).resolves.toEqual([
      "access-v2",
      "access-v2",
    ]);
    expect(oldRefresh).toHaveBeenCalledOnce();
    expect(newRefresh).toHaveBeenCalledOnce();
  });
});
