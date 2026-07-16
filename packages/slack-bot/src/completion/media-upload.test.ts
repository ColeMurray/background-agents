import { describe, expect, it, vi } from "vitest";
import type { MediaArtifactInfo } from "@open-inspect/shared";
import { deliverMediaArtifacts, SLACK_MEDIA_MAX_FILES_PER_COMPLETION } from "./media-upload";
import type { Env } from "../types";

function createKv(): KVNamespace {
  const values = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      values.delete(key);
    }),
  } as unknown as KVNamespace;
}

function makeEnv(
  mediaResponse = new Response("png-bytes", {
    headers: { "Content-Type": "image/png", "Content-Length": "9" },
  })
): Env {
  return {
    SLACK_KV: createKv(),
    CONTROL_PLANE: { fetch: vi.fn(async () => mediaResponse) } as unknown as Fetcher,
    DEPLOYMENT_NAME: "test",
    CONTROL_PLANE_URL: "https://control-plane.test",
    WEB_APP_URL: "https://app.test",
    DEFAULT_MODEL: "anthropic/claude-haiku-4-5",
    CLASSIFICATION_MODEL: "anthropic/claude-haiku-4-5",
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

describe("deliverMediaArtifacts", () => {
  it("streams protected media into the originating Slack thread", async () => {
    const env = makeEnv();
    const slackFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          upload_url: "https://files.slack.com/upload/v1/ticket",
          file_id: "F123",
        })
      )
      .mockResolvedValueOnce(new Response("OK"))
      .mockResolvedValueOnce(Response.json({ ok: true, files: [{ id: "F123" }] }));

    const result = await deliverMediaArtifacts({
      env,
      sessionId: "session-1",
      messageId: "message-1",
      channel: "C123",
      threadTs: "111.222",
      artifacts: [IMAGE],
      traceId: "trace-1",
    });

    expect(result).toEqual({ uploaded: 1, failed: 0, omitted: 0, alreadyDelivered: 0 });
    expect(env.CONTROL_PLANE.fetch).toHaveBeenCalledWith(
      "https://internal/sessions/session-1/media/image-1",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: expect.any(String) }),
        signal: expect.any(AbortSignal),
      })
    );
    expect(slackFetch.mock.calls[1]?.[0]).toBe("https://files.slack.com/upload/v1/ticket");
    expect(
      (slackFetch.mock.calls[1]?.[1]?.headers as Record<string, string>).Authorization
    ).toBeUndefined();
    const completeBody = JSON.parse(String(slackFetch.mock.calls[2]?.[1]?.body));
    expect(completeBody).toMatchObject({ channel_id: "C123", thread_ts: "111.222" });
  });

  it("skips already uploaded artifacts and enforces the per-completion count", async () => {
    const env = makeEnv();
    const artifacts = Array.from(
      { length: SLACK_MEDIA_MAX_FILES_PER_COMPLETION + 2 },
      (_, index) => ({
        ...IMAGE,
        id: `image-${index}`,
      })
    );
    await env.SLACK_KV.put("completion-media:v1:session-1:message-1:image-0", "uploaded");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ ok: false, error: "missing_scope" })
    );

    const result = await deliverMediaArtifacts({
      env,
      sessionId: "session-1",
      messageId: "message-1",
      channel: "C123",
      threadTs: "111.222",
      artifacts,
    });

    expect(result.omitted).toBe(2);
    expect(result.alreadyDelivered).toBe(1);
    expect(result.failed).toBe(SLACK_MEDIA_MAX_FILES_PER_COMPLETION - 1);
  });

  it("releases the upload claim when media retrieval fails", async () => {
    const env = makeEnv(new Response("missing", { status: 404 }));

    const result = await deliverMediaArtifacts({
      env,
      sessionId: "session-1",
      messageId: "message-1",
      channel: "C123",
      threadTs: "111.222",
      artifacts: [IMAGE],
    });

    expect(result).toEqual({ uploaded: 0, failed: 1, omitted: 0, alreadyDelivered: 0 });
    expect(env.SLACK_KV.delete).toHaveBeenCalledWith(
      "completion-media:v1:session-1:message-1:image-1"
    );
  });

  it("skips known oversized media without fetching it", async () => {
    const env = makeEnv();

    const result = await deliverMediaArtifacts({
      env,
      sessionId: "session-1",
      messageId: "message-1",
      channel: "C123",
      threadTs: "111.222",
      artifacts: [{ ...IMAGE, sizeBytes: 11 * 1024 * 1024 }],
    });

    expect(result).toEqual({ uploaded: 0, failed: 0, omitted: 1, alreadyDelivered: 0 });
    expect(env.CONTROL_PLANE.fetch).not.toHaveBeenCalled();
  });

  it("isolates unexpected media delivery errors", async () => {
    const env = makeEnv();
    vi.mocked(env.CONTROL_PLANE.fetch).mockRejectedValueOnce(new Error("binding unavailable"));

    await expect(
      deliverMediaArtifacts({
        env,
        sessionId: "session-1",
        messageId: "message-1",
        channel: "C123",
        threadTs: "111.222",
        artifacts: [IMAGE],
      })
    ).resolves.toEqual({ uploaded: 0, failed: 1, omitted: 0, alreadyDelivered: 0 });
  });
});
