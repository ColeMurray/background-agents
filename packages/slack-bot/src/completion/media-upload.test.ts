import { afterEach, describe, expect, it, vi } from "vitest";
import type { MediaArtifactInfo } from "@open-inspect/shared";
import { deliverMediaArtifacts, SLACK_MEDIA_MAX_FILES_PER_COMPLETION } from "./media-upload";
import type { Env } from "../types";

afterEach(() => {
  vi.restoreAllMocks();
});

function mediaResponse(sizeBytes = 9, body: BodyInit = "png-bytes"): Response {
  return new Response(body, {
    headers: { "Content-Type": "image/png", "Content-Length": String(sizeBytes) },
  });
}

function makeEnv(fetchMedia: () => Promise<Response> = async () => mediaResponse()): Env {
  return {
    SLACK_KV: {} as KVNamespace,
    SLACK_COMPLETION_QUEUE: {} as Queue,
    CONTROL_PLANE: { fetch: vi.fn(fetchMedia) } as unknown as Fetcher,
    DEPLOYMENT_NAME: "test",
    CONTROL_PLANE_URL: "https://control-plane.test",
    WEB_APP_URL: "https://app.test",
    DEFAULT_MODEL: "anthropic/claude-haiku-4-5",
    CLASSIFICATION_MODEL: "anthropic/claude-haiku-4-5",
    SLACK_MEDIA_DELIVERY_ENABLED: "true",
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_SIGNING_SECRET: "signing-secret",
    ANTHROPIC_API_KEY: "test-key",
    INTERNAL_CALLBACK_SECRET: "internal-secret",
  };
}

const IMAGE: MediaArtifactInfo = {
  id: "image-1",
  type: "screenshot",
  mimeType: "image/png",
  sizeBytes: 9,
  caption: "Revenue chart",
};

function input(env: Env, artifacts: MediaArtifactInfo[]) {
  return {
    env,
    sessionId: "session-1",
    messageId: "message-1",
    channel: "C123",
    threadTs: "111.222",
    artifacts,
    traceId: "trace-1",
  };
}

describe("deliverMediaArtifacts", () => {
  it("stages files serially and finalizes them in one ordered call", async () => {
    const env = makeEnv();
    const slackFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          upload_url: "https://files.slack.com/upload/v1/one",
          file_id: "F1",
        })
      )
      .mockResolvedValueOnce(new Response("OK"))
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          upload_url: "https://files.slack.com/upload/v1/two",
          file_id: "F2",
        })
      )
      .mockResolvedValueOnce(new Response("OK"))
      .mockResolvedValueOnce(Response.json({ ok: true, files: [{ id: "F1" }, { id: "F2" }] }));

    const result = await deliverMediaArtifacts(
      input(env, [IMAGE, { ...IMAGE, id: "image-2", caption: "Forecast" }])
    );

    expect(result).toEqual({ uploaded: 2, failed: 0, omitted: 0 });
    expect(env.CONTROL_PLANE.fetch).toHaveBeenCalledTimes(2);
    expect(slackFetch.mock.calls[1]?.[0]).toBe("https://files.slack.com/upload/v1/one");
    expect(slackFetch.mock.calls[3]?.[0]).toBe("https://files.slack.com/upload/v1/two");
    const completeCalls = slackFetch.mock.calls.filter(([url]) =>
      String(url).includes("files.completeUploadExternal")
    );
    expect(completeCalls).toHaveLength(1);
    expect(JSON.parse(String(completeCalls[0]?.[1]?.body))).toEqual({
      files: [
        { id: "F1", title: "Revenue chart" },
        { id: "F2", title: "Forecast" },
      ],
      channel_id: "C123",
      thread_ts: "111.222",
    });
  });

  it("deduplicates artifact ids and enforces the per-completion count", async () => {
    const env = makeEnv();
    const artifacts = [
      IMAGE,
      IMAGE,
      ...Array.from({ length: SLACK_MEDIA_MAX_FILES_PER_COMPLETION + 1 }, (_, index) => ({
        ...IMAGE,
        id: `other-${index}`,
      })),
    ];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ ok: false, error: "missing_scope" })
    );

    const result = await deliverMediaArtifacts(input(env, artifacts));

    expect(result).toEqual({
      uploaded: 0,
      failed: SLACK_MEDIA_MAX_FILES_PER_COMPLETION,
      omitted: 2,
    });
    expect(env.CONTROL_PLANE.fetch).toHaveBeenCalledTimes(SLACK_MEDIA_MAX_FILES_PER_COMPLETION);
  });

  it("skips known oversized media without fetching it", async () => {
    const env = makeEnv();

    const result = await deliverMediaArtifacts(
      input(env, [{ ...IMAGE, sizeBytes: 11 * 1024 * 1024 }])
    );

    expect(result).toEqual({ uploaded: 0, failed: 0, omitted: 1 });
    expect(env.CONTROL_PLANE.fetch).not.toHaveBeenCalled();
  });

  it("cancels protected bodies rejected before upload", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream({ cancel });
    const env = makeEnv(
      async () =>
        new Response(stream, {
          headers: { "Content-Type": "application/octet-stream", "Content-Length": "9" },
        })
    );

    const result = await deliverMediaArtifacts(input(env, [IMAGE]));

    expect(result).toEqual({ uploaded: 0, failed: 1, omitted: 0 });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("counts failed upload attempts toward the total byte limit", async () => {
    const tenMiB = 10 * 1024 * 1024;
    const env = makeEnv(async () => mediaResponse(tenMiB));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ ok: false, error: "missing_scope" })
    );

    const result = await deliverMediaArtifacts(
      input(env, [
        { ...IMAGE, id: "one", sizeBytes: tenMiB },
        { ...IMAGE, id: "two", sizeBytes: tenMiB },
        { ...IMAGE, id: "three", sizeBytes: 6 * 1024 * 1024 },
      ])
    );

    expect(result).toEqual({ uploaded: 0, failed: 2, omitted: 1 });
    expect(env.CONTROL_PLANE.fetch).toHaveBeenCalledTimes(2);
  });

  it("finalizes the successful subset when another artifact fails", async () => {
    const env = makeEnv();
    const slackFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ ok: false, error: "missing_scope" }))
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          upload_url: "https://files.slack.com/upload/v1/two",
          file_id: "F2",
        })
      )
      .mockResolvedValueOnce(new Response("OK"))
      .mockResolvedValueOnce(Response.json({ ok: true, files: [{ id: "F2" }] }));

    const result = await deliverMediaArtifacts(
      input(env, [IMAGE, { ...IMAGE, id: "image-2", caption: "Forecast" }])
    );

    expect(result).toEqual({ uploaded: 1, failed: 1, omitted: 0 });
    const completeCall = slackFetch.mock.calls.find(([url]) =>
      String(url).includes("files.completeUploadExternal")
    );
    const completeBody = JSON.parse(String(completeCall?.[1]?.body));
    expect(completeBody.files).toEqual([{ id: "F2", title: "Forecast" }]);
  });

  it("reports every staged file as failed when finalization fails", async () => {
    const env = makeEnv();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          upload_url: "https://files.slack.com/upload/v1/one",
          file_id: "F1",
        })
      )
      .mockResolvedValueOnce(new Response("OK"))
      .mockResolvedValueOnce(Response.json({ ok: false, error: "internal_error" }));

    const result = await deliverMediaArtifacts(input(env, [IMAGE]));

    expect(result).toEqual({ uploaded: 0, failed: 1, omitted: 0 });
  });

  it("isolates unexpected media retrieval errors", async () => {
    const env = makeEnv(async () => {
      throw new Error("binding unavailable");
    });

    await expect(deliverMediaArtifacts(input(env, [IMAGE]))).resolves.toEqual({
      uploaded: 0,
      failed: 1,
      omitted: 0,
    });
  });
});
