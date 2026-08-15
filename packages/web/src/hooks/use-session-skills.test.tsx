// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSessionSkills } from "./use-session-skills";

vi.mock("swr", () => ({
  default: () => ({
    data: { skills: [], activation: { status: "pending" } },
    isLoading: false,
    error: undefined,
  }),
}));

afterEach(() => {
  vi.useRealTimers();
});

describe("useSessionSkills", () => {
  it("resets activation report availability when the session changes", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ sessionId }) => useSessionSkills(sessionId), {
      initialProps: { sessionId: "session-1" },
    });

    act(() => vi.advanceTimersByTime(10 * 60 * 1000));
    expect(result.current.activationReportUnavailable).toBe(true);

    rerender({ sessionId: "session-2" });
    expect(result.current.activationReportUnavailable).toBe(false);
  });
});
