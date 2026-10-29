import { afterEach, describe, expect, it, vi } from "vitest";
import { withinProviderAccessDeadline } from "./provider-access-deadline";

afterEach(() => vi.useRealTimers());

describe("provider access caller deadline", () => {
  it("bounds the caller without cancelling an already-rotated credential commit", async () => {
    vi.useFakeTimers();
    let persist!: () => void;
    let committed = false;
    const work = new Promise<void>((resolve) => {
      persist = resolve;
    }).then(() => {
      committed = true;
    });
    const waiting = withinProviderAccessDeadline(work, Date.now() + 50);
    const denied = expect(waiting).rejects.toMatchObject({ code: "deadline_exceeded" });
    await vi.advanceTimersByTimeAsync(50);
    await denied;
    expect(committed).toBe(false);
    persist();
    await work;
    expect(committed).toBe(true);
  });

  it("clears its timer when the operation completes", async () => {
    vi.useFakeTimers();
    await expect(
      withinProviderAccessDeadline(Promise.resolve("done"), Date.now() + 50)
    ).resolves.toBe("done");
    expect(vi.getTimerCount()).toBe(0);
  });
});
