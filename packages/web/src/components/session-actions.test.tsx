// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { useSessionActionControls } from "./session-actions";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("useSessionActionControls", () => {
  it("reports archive and unarchive failures without rejecting", async () => {
    const archive = renderHook(() =>
      useSessionActionControls({
        sessionId: "session-1",
        sessionStatus: "active",
        onArchive: () => Promise.reject(new Error("archive failed")),
      })
    );
    const unarchive = renderHook(() =>
      useSessionActionControls({
        sessionId: "session-1",
        sessionStatus: "archived",
        onUnarchive: () => Promise.reject(new Error("unarchive failed")),
      })
    );

    await act(() => archive.result.current.handleConfirmArchive());
    await act(() => unarchive.result.current.handleArchiveToggle());

    expect(toast.error).toHaveBeenCalledWith("Failed to archive session");
    expect(toast.error).toHaveBeenCalledWith("Failed to unarchive session");
    expect(archive.result.current.isArchiving).toBe(false);
    expect(unarchive.result.current.isArchiving).toBe(false);
  });

  it("reports clipboard failures without rejecting", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("permission denied")) },
    });
    const { result } = renderHook(() =>
      useSessionActionControls({ sessionId: "session-1", sessionStatus: "active" })
    );

    await act(() => result.current.handleCopyLink());

    expect(toast.error).toHaveBeenCalledWith("Failed to copy link");
    expect(toast.success).not.toHaveBeenCalled();
  });
});
