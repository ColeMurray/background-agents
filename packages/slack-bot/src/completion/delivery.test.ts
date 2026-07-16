import { afterEach, describe, expect, it, vi } from "vitest";
import { processSlackCompletion } from "./delivery";
import { extractAgentResponse } from "./extractor";
import { deliverMediaArtifacts } from "./media-upload";
import type { SlackCompletionJob } from "./job";
import type { Env } from "../types";
import type * as ExtractorModule from "./extractor";
import type * as MediaUploadModule from "./media-upload";

vi.mock("./extractor", async (importOriginal) => {
  const actual = await importOriginal<typeof ExtractorModule>();
  return { ...actual, extractAgentResponse: vi.fn() };
});

vi.mock("./media-upload", async (importOriginal) => {
  const actual = await importOriginal<typeof MediaUploadModule>();
  return { ...actual, deliverMediaArtifacts: vi.fn() };
});

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    SLACK_KV: {} as KVNamespace,
    SLACK_COMPLETION_QUEUE: {} as Queue,
    CONTROL_PLANE: { fetch: vi.fn() } as unknown as Fetcher,
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
    LOG_LEVEL: "error",
    ...overrides,
  };
}

function job(overrides: Partial<SlackCompletionJob> = {}): SlackCompletionJob {
  return {
    version: 1,
    deliveryId: "11111111-1111-4111-8111-111111111111",
    source: "session",
    sessionId: "session-1",
    messageId: "message-1",
    success: true,
    channel: "C123",
    threadTs: "111.222",
    reactionMessageTs: "111.222",
    context: { repoFullName: "acme/app", model: "anthropic/claude-haiku-4-5" },
    traceId: "trace-1",
    ...overrides,
  };
}

function successfulAgentResponse() {
  return {
    textContent: "Generated the chart.",
    toolCalls: [],
    artifacts: [],
    mediaArtifacts: [{ id: "image-1", type: "screenshot" as const }],
    success: true,
  };
}

describe("processSlackCompletion", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(extractAgentResponse).mockReset();
    vi.mocked(deliverMediaArtifacts).mockReset();
  });

  it("posts text, delivers media, reports failures, and clears the reaction", async () => {
    vi.mocked(extractAgentResponse).mockResolvedValue(successfulAgentResponse());
    vi.mocked(deliverMediaArtifacts).mockResolvedValue({ uploaded: 0, failed: 1, omitted: 0 });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ ok: true, channel: "C123", ts: "333.444" }))
      .mockResolvedValueOnce(Response.json({ ok: true, channel: "C123", ts: "333.445" }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    const env = makeEnv();

    await processSlackCompletion(job(), env);

    expect(deliverMediaArtifacts).toHaveBeenCalledWith({
      env,
      sessionId: "session-1",
      messageId: "message-1",
      channel: "C123",
      threadTs: "111.222",
      artifacts: [{ id: "image-1", type: "screenshot" }],
      traceId: "trace-1",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("chat.postMessage");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("chat.postMessage");
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain("reactions.remove");
  });

  it("keeps text completion and reaction cleanup when media is disabled", async () => {
    vi.mocked(extractAgentResponse).mockResolvedValue(successfulAgentResponse());
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ ok: true, channel: "C123", ts: "333.444" }))
      .mockResolvedValueOnce(Response.json({ ok: true }));

    await processSlackCompletion(job(), makeEnv({ SLACK_MEDIA_DELIVERY_ENABLED: "false" }));

    expect(deliverMediaArtifacts).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("skips media when the ordinary completion post fails", async () => {
    vi.mocked(extractAgentResponse).mockResolvedValue(successfulAgentResponse());
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ ok: false, error: "channel_not_found" }))
      .mockResolvedValueOnce(Response.json({ ok: true }));

    await processSlackCompletion(job(), makeEnv());

    expect(deliverMediaArtifacts).not.toHaveBeenCalled();
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("reactions.remove");
  });

  it("clears the reaction when extraction throws", async () => {
    vi.mocked(extractAgentResponse).mockRejectedValue(new Error("control plane unavailable"));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ok: true }));

    await expect(processSlackCompletion(job(), makeEnv())).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("reactions.remove");
  });
});
