import { afterEach, describe, expect, it, vi } from "vitest";
import type { MediaArtifactInfo } from "@open-inspect/shared/types/artifacts";
import { ProtectedReadError } from "@open-inspect/shared/completion/extractor";
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

function uploadTicket(fileId = "F1"): Response {
  return Response.json({
    ok: true,
    upload_url: `https://files.slack.com/upload/${fileId}`,
    file_id: fileId,
  });
}

function makeEnv(
  fetchMedia: () => Promise<Response> = async () => mediaResponse(),
  fetchAccess: () => Promise<Response> = async () => Response.json({ artifacts: [] })
): Env {
  return {
    SLACK_KV: { get: vi.fn(async () => null) } as unknown as KVNamespace,
    SLACK_COMPLETION_QUEUE: {} as Queue,
    CONTROL_PLANE: {
      fetch: vi.fn(async (input: RequestInfo | URL) =>
        new URL(String(input)).pathname.endsWith("/artifacts") ? fetchAccess() : fetchMedia()
      ),
    } as unknown as Fetcher,
    DEPLOYMENT_NAME: "test",
    CONTROL_PLANE_URL: "https://control-plane.test",
    WEB_APP_URL: "https://app.test",
    DEFAULT_MODEL: "anthropic/claude-haiku-4-5",
    CLASSIFICATION_MODEL: "anthropic/claude-haiku-4-5",
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_SIGNING_SECRET: "signing-secret",
    ANTHROPIC_API_KEY: "test-key",
    SERVICE_AUTH_SECRET: "internal-secret",
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
    onShareAttempt: vi.fn(),
  };
}

describe("deliverMediaArtifacts", () => {
  it.each([
    ["media", 404],
    ["ticket", 403],
    ["upload", 503],
  ] as const)(
    "stops the batch without sharing staged files after a %s failure and proof status %s",
    async (stage, status) => {
      const env = makeEnv(undefined, async () => new Response(null, { status }));
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(uploadTicket())
        .mockResolvedValueOnce(new Response("OK"));
      if (stage === "media") {
        vi.mocked(env.CONTROL_PLANE.fetch)
          .mockResolvedValueOnce(mediaResponse())
          .mockResolvedValueOnce(new Response(null, { status: 404 }));
      } else {
        fetch.mockResolvedValueOnce(
          stage === "ticket"
            ? Response.json({ ok: false, error: "missing_scope" })
            : uploadTicket("F2")
        );
        if (stage === "upload") fetch.mockRejectedValueOnce(new Error("temporary upload failure"));
      }
      const delivery = input(env, [IMAGE, { ...IMAGE, id: "denied" }, { ...IMAGE, id: "later" }]);
      const pending = deliverMediaArtifacts(delivery);
      await expect(pending).rejects.toBeInstanceOf(ProtectedReadError);
      await expect(pending).rejects.toMatchObject({
        kind: status === 503 ? "unavailable" : "denied",
      });
      expect(delivery.onShareAttempt).not.toHaveBeenCalled();
      expect(env.CONTROL_PLANE.fetch).toHaveBeenCalledTimes(3);
      expect(new URL(String(vi.mocked(env.CONTROL_PLANE.fetch).mock.calls[2]?.[0])).pathname).toBe(
        "/sessions/session-1/artifacts"
      );
      expect(
        fetch.mock.calls.some(([url]) => String(url).includes("files.completeUploadExternal"))
      ).toBe(false);
    }
  );

  it.each([true, false])("does not share files when closure is initial=%s", async (initial) => {
    const env = makeEnv();
    const get = vi.fn().mockResolvedValue({
      sessionId: "session-1",
      repoId: "acme/app",
      repoFullName: "acme/app",
      model: "openai/gpt-5.4",
      createdAt: 1,
      closed: true,
    });
    if (!initial) get.mockResolvedValueOnce(null);
    env.SLACK_KV = { get } as unknown as KVNamespace;
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(uploadTicket())
      .mockResolvedValueOnce(new Response("OK"));
    const delivery = input(env, [IMAGE]);
    expect((await deliverMediaArtifacts(delivery)).uploaded).toBe(0);
    expect(delivery.onShareAttempt).not.toHaveBeenCalled();
    expect(env.CONTROL_PLANE.fetch).toHaveBeenCalledTimes(initial ? 0 : 1);
    expect(fetch).toHaveBeenCalledTimes(initial ? 0 : 2);
    expect(
      fetch.mock.calls.some(([url]) => String(url).includes("files.completeUploadExternal"))
    ).toBe(false);
  });

  it("stages files serially and finalizes them in one ordered call", async () => {
    const env = makeEnv();
    const delivery = input(env, [IMAGE, { ...IMAGE, id: "image-2", caption: "Forecast" }]);
    const slackFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(uploadTicket())
      .mockResolvedValueOnce(new Response("OK"))
      .mockResolvedValueOnce(uploadTicket("F2"))
      .mockResolvedValueOnce(new Response("OK"))
      .mockImplementationOnce(async () => {
        expect(delivery.onShareAttempt).toHaveBeenCalledOnce();
        return Response.json({ ok: true, files: [{ id: "F1" }, { id: "F2" }] });
      });

    const result = await deliverMediaArtifacts(delivery);

    expect(result).toEqual({ uploaded: 2, failed: 0, omitted: 0 });
    expect(delivery.onShareAttempt).toHaveBeenCalledOnce();
    expect(env.CONTROL_PLANE.fetch).toHaveBeenCalledTimes(2);
    for (const [url, init] of vi.mocked(env.CONTROL_PLANE.fetch).mock.calls) {
      expect(new URL(String(url)).searchParams.get("channel")).toBe("slack:C123");
      expect(new URL(String(url)).searchParams.get("purpose")).toBe("slack-post");
      expect(new Headers(init?.headers).get("X-OpenInspect-Service-Signature")).toMatch(/^sig1\./);
    }
    expect(slackFetch.mock.calls[1]?.[0]).toBe("https://files.slack.com/upload/F1");
    expect(slackFetch.mock.calls[3]?.[0]).toBe("https://files.slack.com/upload/F2");
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
    expect(env.CONTROL_PLANE.fetch).toHaveBeenCalledTimes(2 * SLACK_MEDIA_MAX_FILES_PER_COMPLETION);
    expect(
      vi
        .mocked(env.CONTROL_PLANE.fetch)
        .mock.calls.filter(([url]) => new URL(String(url)).pathname.endsWith("/artifacts"))
    ).toHaveLength(SLACK_MEDIA_MAX_FILES_PER_COMPLETION);
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

    await expect(deliverMediaArtifacts(input(env, [IMAGE]))).resolves.toEqual({
      uploaded: 0,
      failed: 1,
      omitted: 0,
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(env.CONTROL_PLANE.fetch).toHaveBeenCalledTimes(2);
  });

  it("counts failed upload attempts toward the total byte limit", async () => {
    const tenMiB = 10 * 1024 * 1024;
    const env = makeEnv(async () => mediaResponse(tenMiB, new Uint8Array(tenMiB)));
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
    expect(env.CONTROL_PLANE.fetch).toHaveBeenCalledTimes(4);
  });

  it("finalizes the successful subset when another artifact fails", async () => {
    const env = makeEnv();
    const slackFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(uploadTicket())
      .mockRejectedValueOnce(new Error("temporary file upload failure"))
      .mockResolvedValueOnce(uploadTicket("F2"))
      .mockResolvedValueOnce(new Response("OK"))
      .mockResolvedValueOnce(Response.json({ ok: true, files: [{ id: "F2" }] }));

    const result = await deliverMediaArtifacts(
      input(env, [IMAGE, { ...IMAGE, id: "image-2", caption: "Forecast" }])
    );

    expect(result).toEqual({ uploaded: 1, failed: 1, omitted: 0 });
    expect(env.CONTROL_PLANE.fetch).toHaveBeenCalledTimes(3);
    expect(new URL(String(vi.mocked(env.CONTROL_PLANE.fetch).mock.calls[1]?.[0])).pathname).toBe(
      "/sessions/session-1/artifacts"
    );
    const completeCall = slackFetch.mock.calls.find(([url]) =>
      String(url).includes("files.completeUploadExternal")
    );
    const completeBody = JSON.parse(String(completeCall?.[1]?.body));
    expect(completeBody.files).toEqual([{ id: "F2", title: "Forecast" }]);
  });

  it("reports every staged file as failed when finalization fails", async () => {
    const env = makeEnv();
    const delivery = input(env, [IMAGE, { ...IMAGE, id: "image-2" }]);
    let shareReportedBeforeFinalization = false;
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(uploadTicket())
      .mockResolvedValueOnce(new Response("OK"))
      .mockResolvedValueOnce(uploadTicket("F2"))
      .mockResolvedValueOnce(new Response("OK"))
      .mockImplementationOnce(async () => {
        shareReportedBeforeFinalization = delivery.onShareAttempt.mock.calls.length === 1;
        throw new Error("response lost after accepted share");
      });

    const result = await deliverMediaArtifacts(delivery);

    expect(shareReportedBeforeFinalization).toBe(true);
    expect(delivery.onShareAttempt).toHaveBeenCalledOnce();
    expect(env.CONTROL_PLANE.fetch).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ uploaded: 0, failed: 2, omitted: 0 });
  });

  it.each(["network", "body-network", "truncated", "oversized-body"])(
    "counts a failed media read after a fresh allowed publication proof: %s",
    async (failure) => {
      const env = makeEnv(async () => {
        if (failure === "network") throw new Error("binding unavailable");
        if (failure === "body-network")
          return mediaResponse(
            9,
            new ReadableStream({
              start(controller) {
                controller.error(new Error("media download interrupted"));
              },
            })
          );
        if (failure === "truncated") return mediaResponse(9, "partial");
        return mediaResponse(1);
      });
      const delivery = input(env, [IMAGE]);
      const fetch = vi.spyOn(globalThis, "fetch");
      await expect(deliverMediaArtifacts(delivery)).resolves.toEqual({
        uploaded: 0,
        failed: 1,
        omitted: 0,
      });
      expect(delivery.onShareAttempt).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(env.CONTROL_PLANE.fetch).toHaveBeenCalledTimes(2);
    }
  );

  it("rechecks access before continuing the batch or sharing files after a missing artifact", async () => {
    let proofAllowed = false;
    const env = makeEnv(undefined, async () => {
      proofAllowed = true;
      return Response.json({ artifacts: [] });
    });
    vi.mocked(env.CONTROL_PLANE.fetch)
      .mockResolvedValueOnce(mediaResponse())
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    const delivery = input(env, [IMAGE, { ...IMAGE, id: "missing" }, { ...IMAGE, id: "later" }]);
    delivery.onShareAttempt.mockImplementation(() => expect(proofAllowed).toBe(true));
    const slackFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(uploadTicket())
      .mockResolvedValueOnce(new Response("OK"))
      .mockImplementationOnce(async () => {
        expect(proofAllowed).toBe(true);
        return uploadTicket("F3");
      })
      .mockResolvedValueOnce(new Response("OK"))
      .mockImplementationOnce(async () => {
        expect(proofAllowed).toBe(true);
        expect(delivery.onShareAttempt).toHaveBeenCalledOnce();
        return Response.json({ ok: true, files: [{ id: "F1" }, { id: "F3" }] });
      });

    await expect(deliverMediaArtifacts(delivery)).resolves.toEqual({
      uploaded: 2,
      failed: 1,
      omitted: 0,
    });
    expect(
      vi.mocked(env.CONTROL_PLANE.fetch).mock.calls.map(([url]) => new URL(String(url)).pathname)
    ).toEqual([
      "/sessions/session-1/media/image-1",
      "/sessions/session-1/media/missing",
      "/sessions/session-1/artifacts",
      "/sessions/session-1/media/later",
    ]);
    const completeCall = slackFetch.mock.calls.find(([url]) =>
      String(url).includes("files.completeUploadExternal")
    );
    expect(JSON.parse(String(completeCall?.[1]?.body)).files).toEqual([
      { id: "F1", title: "Revenue chart" },
      { id: "F3", title: "Revenue chart" },
    ]);
  });
});
