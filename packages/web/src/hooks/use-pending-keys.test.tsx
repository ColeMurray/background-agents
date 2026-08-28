// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { usePendingKeys } from "./use-pending-keys";

describe("usePendingKeys", () => {
  it("marks the key pending for the action's duration", async () => {
    const { result } = renderHook(() => usePendingKeys());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));

    let run!: Promise<void>;
    act(() => {
      run = result.current.run("k1", () => gate);
    });

    expect(result.current.pending.has("k1")).toBe(true);

    await act(async () => {
      release();
      await run;
    });

    expect(result.current.pending.has("k1")).toBe(false);
  });

  it("clears the key when the action throws", async () => {
    const { result } = renderHook(() => usePendingKeys());

    await act(async () => {
      await expect(
        result.current.run("k1", () => Promise.reject(new Error("boom")))
      ).rejects.toThrow("boom");
    });

    expect(result.current.pending.has("k1")).toBe(false);
  });

  it("tracks concurrent keys independently", async () => {
    const { result } = renderHook(() => usePendingKeys());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));

    let slowRun!: Promise<void>;
    await act(async () => {
      slowRun = result.current.run("slow", () => gate);
      await result.current.run("fast", async () => {});
    });

    expect(result.current.pending.has("slow")).toBe(true);
    expect(result.current.pending.has("fast")).toBe(false);

    await act(async () => {
      release();
      await slowRun;
    });

    expect(result.current.pending.has("slow")).toBe(false);
  });
});
