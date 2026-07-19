// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useSessionDiffPreferences } from "./use-session-diff-preferences";

afterEach(() => localStorage.clear());

describe("useSessionDiffPreferences", () => {
  it("wraps lines by default when the user has not chosen a preference", () => {
    const { result } = renderHook(() => useSessionDiffPreferences());

    expect(result.current.wrap).toBe(true);
  });

  it("restores and persists an explicit no-wrap preference", async () => {
    localStorage.setItem("session-changes.wrap", "false");
    const { result } = renderHook(() => useSessionDiffPreferences());

    await waitFor(() => expect(result.current.wrap).toBe(false));
    act(() => result.current.setWrap(true));

    expect(localStorage.getItem("session-changes.wrap")).toBe("true");
  });
});
