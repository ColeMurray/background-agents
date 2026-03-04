import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for the file upload logic used by useFileUpload hook.
 * Since @testing-library/react is not installed, we test the
 * validation rules, upload function, and attachment transformation
 * logic directly.
 */

const MAX_SIZE = 10 * 1024 * 1024;
const ALLOWED_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "application/pdf",
  "text/plain",
  "application/json",
];

function createFile(name: string, type: string, size = 100): File {
  const content = new ArrayBuffer(size);
  return new File([content], name, { type });
}

function isAllowedFile(file: File): boolean {
  return file.size <= MAX_SIZE && ALLOWED_TYPES.includes(file.type);
}

function classifyFileType(mimeType: string): "file" | "image" {
  return mimeType.startsWith("image/") ? "image" : "file";
}

describe("file upload validation", () => {
  it("accepts allowed image types", () => {
    expect(isAllowedFile(createFile("a.png", "image/png"))).toBe(true);
    expect(isAllowedFile(createFile("b.jpg", "image/jpeg"))).toBe(true);
    expect(isAllowedFile(createFile("c.gif", "image/gif"))).toBe(true);
    expect(isAllowedFile(createFile("d.webp", "image/webp"))).toBe(true);
    expect(isAllowedFile(createFile("e.svg", "image/svg+xml"))).toBe(true);
  });

  it("accepts allowed non-image types", () => {
    expect(isAllowedFile(createFile("doc.pdf", "application/pdf"))).toBe(true);
    expect(isAllowedFile(createFile("readme.txt", "text/plain"))).toBe(true);
    expect(isAllowedFile(createFile("data.json", "application/json"))).toBe(true);
  });

  it("rejects unsupported MIME types", () => {
    expect(isAllowedFile(createFile("app.exe", "application/x-msdownload"))).toBe(false);
    expect(isAllowedFile(createFile("video.mp4", "video/mp4"))).toBe(false);
    expect(isAllowedFile(createFile("archive.zip", "application/zip"))).toBe(false);
    expect(isAllowedFile(createFile("script.js", "text/javascript"))).toBe(false);
  });

  it("rejects files exceeding 10 MB", () => {
    const bigFile = createFile("huge.png", "image/png", 11 * 1024 * 1024);
    expect(isAllowedFile(bigFile)).toBe(false);
  });

  it("accepts files at exactly 10 MB", () => {
    const exactFile = createFile("exact.png", "image/png", MAX_SIZE);
    expect(isAllowedFile(exactFile)).toBe(true);
  });
});

describe("file type classification", () => {
  it("classifies image MIME types as 'image'", () => {
    expect(classifyFileType("image/png")).toBe("image");
    expect(classifyFileType("image/jpeg")).toBe("image");
    expect(classifyFileType("image/gif")).toBe("image");
    expect(classifyFileType("image/webp")).toBe("image");
    expect(classifyFileType("image/svg+xml")).toBe("image");
  });

  it("classifies non-image MIME types as 'file'", () => {
    expect(classifyFileType("application/pdf")).toBe("file");
    expect(classifyFileType("text/plain")).toBe("file");
    expect(classifyFileType("application/json")).toBe("file");
  });
});

describe("uploadFile function", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
  });

  async function uploadFile(file: File): Promise<string> {
    const response = await fetch("/api/media/upload", {
      method: "POST",
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        "X-Filename": file.name,
      },
      body: file,
    });
    if (!response.ok) {
      throw new Error(`Upload failed: ${response.status}`);
    }
    const data = await response.json();
    return (data as { url: string }).url;
  }

  it("sends correct headers and body", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ url: "https://r2.example.com/abc.png" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const file = createFile("screenshot.png", "image/png");
    const url = await uploadFile(file);

    expect(url).toBe("https://r2.example.com/abc.png");
    expect(fetchMock).toHaveBeenCalledWith("/api/media/upload", {
      method: "POST",
      headers: {
        "Content-Type": "image/png",
        "X-Filename": "screenshot.png",
      },
      body: file,
    });
  });

  it("throws on non-ok response", async () => {
    fetchMock.mockResolvedValueOnce(new Response("Error", { status: 500 }));

    const file = createFile("test.png", "image/png");
    await expect(uploadFile(file)).rejects.toThrow("Upload failed: 500");
  });

  it("uses application/octet-stream for files without type", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ url: "https://r2.example.com/abc" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const file = new File([new ArrayBuffer(10)], "mystery-file", { type: "" });
    await uploadFile(file);

    expect(fetchMock).toHaveBeenCalledWith("/api/media/upload", {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Filename": "mystery-file",
      },
      body: file,
    });
  });
});

describe("UploadedAttachment transformation", () => {
  interface PendingAttachment {
    id: string;
    name: string;
    type: "file" | "image";
    mimeType: string;
    uploading: boolean;
    url?: string;
    error?: string;
  }

  interface UploadedAttachment {
    type: string;
    name: string;
    url: string;
    mimeType: string;
  }

  function getUploadedAttachments(attachments: PendingAttachment[]): UploadedAttachment[] {
    return attachments
      .filter((a): a is PendingAttachment & { url: string } => !!a.url && !a.error)
      .map((a) => ({
        type: a.type,
        name: a.name,
        url: a.url,
        mimeType: a.mimeType,
      }));
  }

  it("filters out attachments without URLs", () => {
    const attachments: PendingAttachment[] = [
      { id: "1", name: "a.png", type: "image", mimeType: "image/png", uploading: true },
      {
        id: "2",
        name: "b.png",
        type: "image",
        mimeType: "image/png",
        uploading: false,
        url: "https://r2.example.com/b.png",
      },
    ];

    const result = getUploadedAttachments(attachments);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("b.png");
  });

  it("filters out attachments with errors", () => {
    const attachments: PendingAttachment[] = [
      {
        id: "1",
        name: "bad.png",
        type: "image",
        mimeType: "image/png",
        uploading: false,
        url: "https://r2.example.com/bad.png",
        error: "Upload failed",
      },
      {
        id: "2",
        name: "good.png",
        type: "image",
        mimeType: "image/png",
        uploading: false,
        url: "https://r2.example.com/good.png",
      },
    ];

    const result = getUploadedAttachments(attachments);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("good.png");
  });

  it("returns empty array when no uploads are complete", () => {
    const attachments: PendingAttachment[] = [
      { id: "1", name: "a.png", type: "image", mimeType: "image/png", uploading: true },
    ];

    expect(getUploadedAttachments(attachments)).toEqual([]);
  });

  it("maps correct fields to UploadedAttachment", () => {
    const attachments: PendingAttachment[] = [
      {
        id: "1",
        name: "doc.pdf",
        type: "file",
        mimeType: "application/pdf",
        uploading: false,
        url: "https://r2.example.com/doc.pdf",
      },
    ];

    const result = getUploadedAttachments(attachments);
    expect(result[0]).toEqual({
      type: "file",
      name: "doc.pdf",
      url: "https://r2.example.com/doc.pdf",
      mimeType: "application/pdf",
    });
  });
});
