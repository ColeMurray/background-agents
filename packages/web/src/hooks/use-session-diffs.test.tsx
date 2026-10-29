// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { useSessionDiffRetry } from "./use-session-diffs";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("toasts the server reason_code when retry is denied", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({ error: "Forbidden", reason_code: "team_inactive" }, { status: 403 })
    )
  );
  const { result } = renderHook(() => useSessionDiffRetry("session-1"));
  await act(async () => expect(await result.current.retry()).toBe(false));
  expect(toast.error).toHaveBeenCalledWith("Changes could not be retried. (team_inactive)");
  expect(result.current.isRetrying).toBe(false);
});
