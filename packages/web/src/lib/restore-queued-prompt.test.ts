// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { restoreQueuedPrompt } from "./restore-queued-prompt";

describe("restoreQueuedPrompt", () => {
  it("restores and focuses a removed prompt when the composer is empty", () => {
    const input = document.createElement("textarea");
    const focus = vi.spyOn(input, "focus");
    const setPrompt = vi.fn();

    expect(
      restoreQueuedPrompt({
        content: "Revise this",
        currentPrompt: "  ",
        hasAttachments: false,
        setPrompt,
        input,
      })
    ).toBe(true);
    expect(setPrompt).toHaveBeenCalledWith("Revise this");
    expect(focus).toHaveBeenCalledOnce();
  });

  it.each([
    { currentPrompt: "New draft", hasAttachments: false },
    { currentPrompt: "", hasAttachments: true },
  ])("does not overwrite composer content", ({ currentPrompt, hasAttachments }) => {
    const input = document.createElement("textarea");
    const focus = vi.spyOn(input, "focus");
    const setPrompt = vi.fn();

    expect(
      restoreQueuedPrompt({
        content: "Removed prompt",
        currentPrompt,
        hasAttachments,
        setPrompt,
        input,
      })
    ).toBe(false);
    expect(setPrompt).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
  });
});
