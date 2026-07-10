// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePromptAttachments } from "./use-prompt-attachments";

describe("usePromptAttachments", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reuses successful upload IDs when a later file fails and the user retries", async () => {
    vi.spyOn(URL, "createObjectURL")
      .mockReturnValueOnce("blob:first")
      .mockReturnValueOnce("blob:second");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ uploadId: "up-1", mimeType: "image/png" }, { status: 201 })
      )
      .mockResolvedValueOnce(Response.json({ error: "temporary failure" }, { status: 503 }))
      .mockResolvedValueOnce(
        Response.json({ uploadId: "up-2", mimeType: "image/png" }, { status: 201 })
      );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => usePromptAttachments());
    act(() => {
      result.current.addFiles([
        new File(["first"], "first.png", { type: "image/png" }),
        new File(["second"], "second.png", { type: "image/png" }),
      ]);
    });

    await expect(result.current.uploadAll("session-1")).rejects.toThrow("temporary failure");
    let uploaded = [] as Awaited<ReturnType<typeof result.current.uploadAll>>;
    await act(async () => {
      uploaded = await result.current.uploadAll("session-1");
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(uploaded.map((attachment) => attachment.uploadId)).toEqual(["up-1", "up-2"]);
  });
});
