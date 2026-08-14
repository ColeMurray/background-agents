// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePersistedBoolean } from "./use-persisted-boolean";

const STORAGE_KEY = "test-persisted-boolean";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("usePersistedBoolean", () => {
  it("restores a stored preference after mount", async () => {
    localStorage.setItem(STORAGE_KEY, "false");
    const { result } = renderHook(() => usePersistedBoolean(STORAGE_KEY, true));

    await waitFor(() => expect(result.current.value).toBe(false));
  });

  it("keeps the default when nothing is stored", () => {
    const { result } = renderHook(() => usePersistedBoolean(STORAGE_KEY, true));

    expect(result.current.value).toBe(true);
  });

  it("persists toggles and explicit updates", async () => {
    const { result } = renderHook(() => usePersistedBoolean(STORAGE_KEY, true));

    act(() => result.current.toggle());
    expect(result.current.value).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBe("false");

    act(() => result.current.setValue(true));
    expect(result.current.value).toBe(true);
    expect(localStorage.getItem(STORAGE_KEY)).toBe("true");
  });

  it("keeps working when localStorage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });

    const { result } = renderHook(() => usePersistedBoolean(STORAGE_KEY, true));

    act(() => result.current.toggle());
    expect(result.current.value).toBe(false);
  });
});
