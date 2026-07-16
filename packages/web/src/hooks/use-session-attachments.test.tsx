// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WEB_SESSION_ATTACHMENT_IMAGE_MAX_BYTES } from "@/lib/session-attachment-limits";
import { useSessionAttachments } from "./use-session-attachments";

describe("useSessionAttachments", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("rejects video files before creating a preview", () => {
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:video");
    const { result } = renderHook(() => useSessionAttachments());

    act(() => {
      result.current.addFiles([new File(["video"], "demo.mp4", { type: "video/mp4" })]);
    });

    expect(result.current.attachments).toEqual([]);
    expect(result.current.attachmentError).toBe("demo.mp4 is not a supported image");
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("rejects images above the portable web request limit", () => {
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:image");
    const { result } = renderHook(() => useSessionAttachments());

    act(() => {
      result.current.addFiles([
        new File([new Uint8Array(WEB_SESSION_ATTACHMENT_IMAGE_MAX_BYTES + 1)], "large.png", {
          type: "image/png",
        }),
      ]);
    });

    expect(result.current.attachments).toEqual([]);
    expect(result.current.attachmentError).toBe(
      "large.png is too large (images must be under 4 MB)"
    );
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("reuses successful attachment IDs when a later file fails and the user retries", async () => {
    vi.spyOn(URL, "createObjectURL")
      .mockReturnValueOnce("blob:first")
      .mockReturnValueOnce("blob:second");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ attachmentId: "up-1", mimeType: "image/png" }, { status: 201 })
      )
      .mockResolvedValueOnce(Response.json({ error: "temporary failure" }, { status: 503 }))
      .mockResolvedValueOnce(
        Response.json({ attachmentId: "up-2", mimeType: "image/png" }, { status: 201 })
      );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useSessionAttachments());
    act(() => {
      result.current.addFiles([
        new File(["first"], "first.png", { type: "image/png" }),
        new File(["second"], "second.png", { type: "image/png" }),
      ]);
    });

    await act(async () => {
      await expect(result.current.uploadAll("session-1")).rejects.toThrow("temporary failure");
    });
    let uploaded = [] as Awaited<ReturnType<typeof result.current.uploadAll>>;
    await act(async () => {
      uploaded = await result.current.uploadAll("session-1");
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(uploaded.map((attachment) => attachment.attachmentId)).toEqual(["up-1", "up-2"]);
  });

  it("enforces the attachment limit across back-to-back additions", () => {
    vi.spyOn(URL, "createObjectURL").mockImplementation((file) => `blob:${file}`);
    const { result } = renderHook(() => useSessionAttachments());
    const files = Array.from(
      { length: 8 },
      (_, index) => new File([String(index)], `${index}.png`, { type: "image/png" })
    );

    act(() => {
      result.current.addFiles(files.slice(0, 4));
      result.current.addFiles(files.slice(4));
    });

    expect(result.current.attachments).toHaveLength(6);
    expect(result.current.attachmentError).toBe("You can attach up to 6 files per message");
  });

  it("does not return an attachment removed during upload", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:image");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    let resolveUpload!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveUpload = resolve;
          })
      )
    );
    const { result } = renderHook(() => useSessionAttachments());
    act(() => {
      result.current.addFiles([new File(["image"], "shot.png", { type: "image/png" })]);
    });

    let uploadPromise!: ReturnType<typeof result.current.uploadAll>;
    act(() => {
      uploadPromise = result.current.uploadAll("session-1");
    });
    act(() => {
      result.current.removeAttachment(result.current.attachments[0].id);
      resolveUpload(Response.json({ attachmentId: "up-1" }, { status: 201 }));
    });

    await act(async () => {
      await expect(uploadPromise).rejects.toThrow("Attachments changed during upload");
    });
    expect(result.current.attachments).toEqual([]);
  });
});
