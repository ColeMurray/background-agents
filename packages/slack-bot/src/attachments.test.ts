import type { SlackMessageFile } from "@open-inspect/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractImageFiles,
  notifyDroppedAttachments,
  SLACK_ATTACHMENT_MAX_FILE_BYTES,
  uploadSlackImageAttachments,
} from "./attachments";
import type { Env } from "./types";

function makeEnv(controlPlaneFetch = vi.fn()): Env {
  return {
    SLACK_KV: {} as KVNamespace,
    SLACK_COMPLETION_QUEUE: { send: vi.fn(async () => {}) } as unknown as Queue,
    CONTROL_PLANE: { fetch: controlPlaneFetch } as unknown as Fetcher,
    DEPLOYMENT_NAME: "test",
    CONTROL_PLANE_URL: "https://control-plane.test",
    WEB_APP_URL: "https://app.test",
    DEFAULT_MODEL: "anthropic/claude-haiku-4-5",
    CLASSIFICATION_MODEL: "anthropic/claude-haiku-4-5",
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_SIGNING_SECRET: "signing-secret",
    ANTHROPIC_API_KEY: "test-key",
    INTERNAL_CALLBACK_SECRET: "callback-secret",
    LOG_LEVEL: "error",
  } as Env;
}

const pngFile: SlackMessageFile = {
  id: "F1",
  name: "screenshot.png",
  mimetype: "image/png",
  url_private: "https://files.slack.com/files-pri/T1-F1/screenshot.png",
  size: 1024,
};

function imageBytesResponse(size = 16): Response {
  return new Response(new Uint8Array(size).fill(1), { status: 200 });
}

function uploadCreatedResponse(attachmentId = "att-1"): Response {
  return new Response(JSON.stringify({ attachmentId, mimeType: "image/png" }), { status: 201 });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("extractImageFiles", () => {
  it("keeps only supported image mime types", () => {
    const files: SlackMessageFile[] = [
      pngFile,
      { id: "F2", mimetype: "application/pdf", url_private: "https://x/pdf" },
      { id: "F3", mimetype: "image/webp", url_private: "https://x/webp" },
      { id: "F4" },
    ];
    expect(extractImageFiles(files).map((f) => f.id)).toEqual(["F1", "F3"]);
  });

  it("returns [] for undefined or empty input", () => {
    expect(extractImageFiles(undefined)).toEqual([]);
    expect(extractImageFiles([])).toEqual([]);
  });
});

describe("uploadSlackImageAttachments", () => {
  it("downloads from Slack with the bot token and uploads to the session", async () => {
    const downloadSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(imageBytesResponse());
    const controlPlaneFetch = vi.fn().mockResolvedValueOnce(uploadCreatedResponse());
    const env = makeEnv(controlPlaneFetch);

    const result = await uploadSlackImageAttachments(env, "sess-1", [pngFile]);

    expect(result.references).toEqual([{ attachmentId: "att-1", name: "screenshot.png" }]);
    expect(result.droppedCount).toBe(0);

    const [downloadUrl, downloadInit] = downloadSpy.mock.calls[0]!;
    expect(downloadUrl).toBe(pngFile.url_private);
    expect((downloadInit!.headers as Record<string, string>).Authorization).toBe(
      "Bearer xoxb-test"
    );

    const [uploadUrl, uploadInit] = controlPlaneFetch.mock.calls[0]!;
    expect(uploadUrl).toBe("https://internal/sessions/sess-1/attachments");
    expect(uploadInit.method).toBe("POST");
    expect(uploadInit.body).toBeInstanceOf(FormData);
    // Workers-types FormData.get() is typed string | null, so narrow via unknown.
    const uploaded = (uploadInit.body as FormData).get("file") as unknown as File;
    expect(uploaded).toBeInstanceOf(File);
    expect(uploaded.name).toBe("screenshot.png");
    expect(uploaded.type).toBe("image/png");
  });

  it("prefers url_private_download when present", async () => {
    const downloadSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(imageBytesResponse());
    const env = makeEnv(vi.fn().mockResolvedValueOnce(uploadCreatedResponse()));

    await uploadSlackImageAttachments(env, "sess-1", [
      { ...pngFile, url_private_download: "https://files.slack.com/download/F1" },
    ]);

    expect(downloadSpy.mock.calls[0]![0]).toBe("https://files.slack.com/download/F1");
  });

  it("returns immediately when there are no image files", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const env = makeEnv();

    const result = await uploadSlackImageAttachments(env, "sess-1", [
      { id: "F2", mimetype: "text/plain", url_private: "https://x/txt" },
    ]);

    expect(result).toEqual({ references: [], droppedCount: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("drops files whose declared size exceeds the cap without downloading", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const env = makeEnv();

    const result = await uploadSlackImageAttachments(env, "sess-1", [
      { ...pngFile, size: SLACK_ATTACHMENT_MAX_FILE_BYTES + 1 },
    ]);

    expect(result).toEqual({ references: [], droppedCount: 1 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("counts failed downloads as dropped and keeps processing later files", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("denied", { status: 403 }))
      .mockResolvedValueOnce(imageBytesResponse());
    const controlPlaneFetch = vi.fn().mockResolvedValueOnce(uploadCreatedResponse("att-2"));
    const env = makeEnv(controlPlaneFetch);

    const result = await uploadSlackImageAttachments(env, "sess-1", [
      pngFile,
      { ...pngFile, id: "F2", name: "second.png" },
    ]);

    expect(result.references).toEqual([{ attachmentId: "att-2", name: "second.png" }]);
    expect(result.droppedCount).toBe(1);
  });

  it("counts rejected uploads as dropped", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(imageBytesResponse());
    const controlPlaneFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "quota" }), { status: 429 }));
    const env = makeEnv(controlPlaneFetch);

    const result = await uploadSlackImageAttachments(env, "sess-1", [pngFile]);

    expect(result).toEqual({ references: [], droppedCount: 1 });
  });

  it("caps forwarded images at the per-message maximum and drops the rest", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => imageBytesResponse());
    const controlPlaneFetch = vi.fn().mockImplementation(async () => uploadCreatedResponse());
    const env = makeEnv(controlPlaneFetch);
    const files = Array.from({ length: 8 }, (_, i) => ({
      ...pngFile,
      id: `F${i}`,
      name: `img-${i}.png`,
    }));

    const result = await uploadSlackImageAttachments(env, "sess-1", files);

    expect(result.references).toHaveLength(6);
    expect(result.droppedCount).toBe(2);
    expect(controlPlaneFetch).toHaveBeenCalledTimes(6);
  });

  it("skips files with no download URL", async () => {
    const env = makeEnv();

    const result = await uploadSlackImageAttachments(env, "sess-1", [
      { id: "F1", mimetype: "image/png" },
    ]);

    expect(result).toEqual({ references: [], droppedCount: 1 });
  });
});

describe("notifyDroppedAttachments", () => {
  it("does nothing when droppedCount is 0", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await notifyDroppedAttachments(makeEnv(), "C1", "1.0", 0);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("posts a threaded warning naming the files:read scope", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    await notifyDroppedAttachments(makeEnv(), "C1", "1.0", 2);

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain("chat.postMessage");
    const body = JSON.parse(init!.body as string);
    expect(body.channel).toBe("C1");
    expect(body.thread_ts).toBe("1.0");
    expect(body.text).toContain("2 attached images");
    expect(body.text).toContain("files:read");
  });
});
