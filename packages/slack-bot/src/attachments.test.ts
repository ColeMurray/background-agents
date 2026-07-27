import {
  SESSION_ATTACHMENT_IMAGE_MAX_BYTES,
  sha256Hex,
  verifyServiceSignature,
  type SlackMessageFile,
} from "@open-inspect/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  notifyDroppedAttachments,
  prepareImageAttachments,
  toImageAttachments,
  uploadPreparedAttachments,
  type SlackImageAttachment,
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
    SERVICE_AUTH_SECRET: "callback-secret",
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

const pngAttachment: SlackImageAttachment = {
  id: "F1",
  name: "screenshot.png",
  mimetype: "image/png",
  size: 1024,
  downloadUrl: "https://files.slack.com/files-pri/T1-F1/screenshot.png",
};

function imageBytesResponse(size = 16): Response {
  return new Response(new Uint8Array(size).fill(1), { status: 200 });
}

function uploadCreatedResponse(attachmentId = "att-1"): Response {
  return new Response(JSON.stringify({ attachmentId, mimeType: "image/png" }), { status: 201 });
}

/** Download + upload in one step, as the delivery pipeline runs them. */
async function prepareAndUpload(env: Env, sessionId: string, files: SlackMessageFile[]) {
  const prepared = await prepareImageAttachments(env, toImageAttachments(files));
  return uploadPreparedAttachments(env, sessionId, prepared);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("toImageAttachments", () => {
  it("keeps only supported image mime types", () => {
    const files: SlackMessageFile[] = [
      pngFile,
      { id: "F2", mimetype: "application/pdf", url_private: "https://files.slack.com/pdf" },
      { id: "F3", mimetype: "image/webp", url_private: "https://files.slack.com/webp" },
      { id: "F4" },
    ];
    expect(toImageAttachments(files).map((f) => f.id)).toEqual(["F1", "F3"]);
  });

  it("returns [] for undefined or empty input", () => {
    expect(toImageAttachments(undefined)).toEqual([]);
    expect(toImageAttachments([])).toEqual([]);
  });

  it("never admits non-Slack hosts, so the bot token cannot reach them", () => {
    const files: SlackMessageFile[] = [
      { ...pngFile, url_private: "https://evil.example.com/steal-token.png" },
      { ...pngFile, id: "F2", url_private: "http://files.slack.com/not-https.png" },
      { ...pngFile, id: "F3", url_private: "https://files.slack.com.evil.com/x.png" },
    ];
    expect(toImageAttachments(files)).toEqual([]);
  });

  it("skips remote (mode external) files whose URLs are registrant-controlled", () => {
    expect(toImageAttachments([{ ...pngFile, mode: "external" }])).toEqual([]);
  });

  it("skips files with no download URL", () => {
    expect(toImageAttachments([{ id: "F1", mimetype: "image/png" }])).toEqual([]);
  });

  it("prefers url_private_download and carries the declared size", () => {
    const [attachment] = toImageAttachments([
      { ...pngFile, url_private_download: "https://files.slack.com/download/F1" },
    ]);
    expect(attachment!.downloadUrl).toBe("https://files.slack.com/download/F1");
    expect(attachment!.size).toBe(1024);
  });
});

describe("prepareImageAttachments", () => {
  it("downloads from Slack with the bot token and no redirect following", async () => {
    const downloadSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(imageBytesResponse());
    const env = makeEnv();

    const prepared = await prepareImageAttachments(env, [pngAttachment]);

    expect(prepared.files).toHaveLength(1);
    expect(prepared.dropped).toEqual([]);
    const [downloadUrl, downloadInit] = downloadSpy.mock.calls[0]!;
    expect(downloadUrl).toBe(pngAttachment.downloadUrl);
    expect((downloadInit!.headers as Record<string, string>).Authorization).toBe(
      "Bearer xoxb-test"
    );
    expect(downloadInit!.redirect).toBe("manual");
  });

  it("treats redirects as failures so the token cannot leak downstream", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { Location: "https://evil.example.com" } })
    );

    const prepared = await prepareImageAttachments(makeEnv(), [pngAttachment]);

    expect(prepared.files).toEqual([]);
    expect(prepared.dropped).toEqual(["download_failed"]);
  });

  it("rejects oversized bodies via Content-Length before reading them", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(new Uint8Array(16), {
        status: 200,
        headers: { "Content-Length": String(SESSION_ATTACHMENT_IMAGE_MAX_BYTES + 1) },
      })
    );

    const prepared = await prepareImageAttachments(makeEnv(), [
      { ...pngAttachment, size: undefined },
    ]);

    expect(prepared.dropped).toEqual(["too_large"]);
  });

  it("caps streamed bodies that exceed the limit without a Content-Length", async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(1);
    let pushed = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pushed * chunk.byteLength > SESSION_ATTACHMENT_IMAGE_MAX_BYTES) {
          controller.close();
          return;
        }
        pushed += 1;
        controller.enqueue(chunk);
      },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(body, { status: 200 }));

    const prepared = await prepareImageAttachments(makeEnv(), [
      { ...pngAttachment, size: undefined },
    ]);

    expect(prepared.dropped).toEqual(["too_large"]);
  });

  it("drops files whose declared size exceeds the cap without downloading", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const prepared = await prepareImageAttachments(makeEnv(), [
      { ...pngAttachment, size: SESSION_ATTACHMENT_IMAGE_MAX_BYTES + 1 },
    ]);

    expect(prepared).toEqual({ files: [], dropped: ["too_large"] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("counts failed downloads as dropped and keeps later files", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("denied", { status: 403 }))
      .mockResolvedValueOnce(imageBytesResponse());

    const prepared = await prepareImageAttachments(makeEnv(), [
      pngAttachment,
      { ...pngAttachment, id: "F2", name: "second.png" },
    ]);

    expect(prepared.files.map((f) => f.attachment.name)).toEqual(["second.png"]);
    expect(prepared.dropped).toEqual(["download_failed"]);
  });

  it("caps downloads at the per-message maximum and drops the rest", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => imageBytesResponse());
    const attachments = Array.from({ length: 8 }, (_, i) => ({
      ...pngAttachment,
      id: `F${i}`,
      name: `img-${i}.png`,
    }));

    const prepared = await prepareImageAttachments(makeEnv(), attachments);

    expect(prepared.files).toHaveLength(6);
    expect(prepared.dropped).toEqual(["over_cap", "over_cap"]);
    expect(fetchSpy).toHaveBeenCalledTimes(6);
  });

  it("returns immediately when there are no attachments", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const prepared = await prepareImageAttachments(makeEnv(), []);

    expect(prepared).toEqual({ files: [], dropped: [] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("uploadPreparedAttachments", () => {
  it("uploads to the session and returns prompt references", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(imageBytesResponse());
    const controlPlaneFetch = vi.fn().mockResolvedValueOnce(uploadCreatedResponse());
    const env = makeEnv(controlPlaneFetch);

    const result = await prepareAndUpload(env, "sess-1", [pngFile]);

    expect(result.references).toEqual([{ attachmentId: "att-1", name: "screenshot.png" }]);
    expect(result.dropped).toEqual([]);
    expect(result.sessionMissing).toBe(false);

    const [uploadUrl, uploadInit] = controlPlaneFetch.mock.calls[0]!;
    expect(uploadUrl).toBe("https://internal/sessions/sess-1/attachments");
    expect(uploadInit.method).toBe("POST");
    // The multipart form is serialized before signing, so the body is the
    // exact bytes and the Content-Type header carries the boundary they were
    // serialized with. Round-trip them to prove the pair stays parseable.
    expect(uploadInit.body).toBeInstanceOf(Uint8Array);
    const contentType = new Headers(uploadInit.headers).get("Content-Type");
    expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
    const roundTripped = await new Request("https://internal/", {
      method: "POST",
      headers: { "Content-Type": contentType! },
      body: uploadInit.body,
    }).formData();
    const uploaded = roundTripped.get("file") as unknown as File;
    expect(uploaded).toBeInstanceOf(File);
    expect(uploaded.name).toBe("screenshot.png");
    expect(uploaded.type).toBe("image/png");
  });

  it("signs the exact multipart bytes when the sig1 credential is bound", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(imageBytesResponse());
    const controlPlaneFetch = vi.fn().mockResolvedValueOnce(uploadCreatedResponse());
    const env = { ...makeEnv(controlPlaneFetch), SERVICE_AUTH_SECRET: "slack-sig1-secret" };

    await prepareAndUpload(env, "sess-1", [pngFile]);

    const [uploadUrl, uploadInit] = controlPlaneFetch.mock.calls[0]!;
    const headers = new Headers(uploadInit.headers);
    const verified = await verifyServiceSignature({
      signatureHeader: headers.get("X-OpenInspect-Service-Signature")!,
      service: "slack-bot",
      secret: "slack-sig1-secret",
      method: "POST",
      url: uploadUrl,
      bodySha256Hex: await sha256Hex(uploadInit.body as Uint8Array),
      actor: "",
    });
    expect(verified).toMatchObject({ ok: true });
  });

  it("counts rejected uploads as dropped and carries prepare-stage drops forward", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("denied", { status: 403 }))
      .mockResolvedValueOnce(imageBytesResponse());
    const controlPlaneFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "quota" }), { status: 429 }));
    const env = makeEnv(controlPlaneFetch);

    const result = await prepareAndUpload(env, "sess-1", [
      pngFile,
      { ...pngFile, id: "F2", name: "second.png" },
    ]);

    expect(result.references).toEqual([]);
    expect(result.dropped).toEqual(["download_failed", "upload_rejected"]);
    expect(result.sessionMissing).toBe(false);
  });

  it("flags the session as missing when every upload 404s", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => imageBytesResponse());
    const controlPlaneFetch = vi
      .fn()
      .mockImplementation(async () => new Response(null, { status: 404 }));
    const env = makeEnv(controlPlaneFetch);

    const result = await prepareAndUpload(env, "sess-gone", [
      pngFile,
      { ...pngFile, id: "F2", name: "second.png" },
    ]);

    expect(result.references).toEqual([]);
    expect(result.dropped).toEqual(["upload_rejected", "upload_rejected"]);
    expect(result.sessionMissing).toBe(true);
  });

  it("does not flag a missing session when any upload succeeds or fails differently", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => imageBytesResponse());
    const controlPlaneFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 500 }));
    const env = makeEnv(controlPlaneFetch);

    const result = await prepareAndUpload(env, "sess-1", [
      pngFile,
      { ...pngFile, id: "F2", name: "second.png" },
    ]);

    expect(result.sessionMissing).toBe(false);
  });
});

describe("notifyDroppedAttachments", () => {
  it("does nothing when nothing was dropped", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await notifyDroppedAttachments(makeEnv(), "C1", "1.0", { references: [], dropped: [] });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("names the files:read scope only for download failures", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    await notifyDroppedAttachments(makeEnv(), "C1", "1.0", {
      references: [],
      dropped: ["download_failed", "download_failed"],
    });

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain("chat.postMessage");
    const body = JSON.parse(init!.body as string);
    expect(body.channel).toBe("C1");
    expect(body.thread_ts).toBe("1.0");
    expect(body.text).toContain("2 attached images");
    expect(body.text).toContain("files:read");
  });

  it("gives size and cap guidance instead of the scope hint when those caused the drops", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    await notifyDroppedAttachments(makeEnv(), "C1", "1.0", {
      references: [],
      dropped: ["too_large", "over_cap"],
    });

    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
    expect(body.text).not.toContain("files:read");
    expect(body.text).toContain("10 MB or smaller");
    expect(body.text).toContain("at most 6 images");
  });

  it("says no run started when notified with nothingSent", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    await notifyDroppedAttachments(
      makeEnv(),
      "C1",
      "1.0",
      { references: [], dropped: ["download_failed"] },
      { nothingSent: true }
    );

    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
    expect(body.text).toContain("didn't start on this request");
  });
});
