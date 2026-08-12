import { afterEach, describe, expect, it, vi } from "vitest";
import { processSlackCompletion, shouldDeclineReply } from "./delivery";
import { extractAgentResponse } from "./extractor";
import { deliverMediaArtifacts } from "./media-upload";
import type { SlackCompletionJob } from "./job";
import type { AgentResponse } from "@open-inspect/shared/types/artifacts";
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
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_SIGNING_SECRET: "signing-secret",
    ANTHROPIC_API_KEY: "test-key",
    SERVICE_AUTH_SECRET: "internal-secret",
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

function declinedAgentResponse(overrides: Partial<AgentResponse> = {}): AgentResponse {
  return {
    textContent: "NO_REPLY",
    toolCalls: [],
    artifacts: [],
    mediaArtifacts: [],
    success: true,
    ...overrides,
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

  it("skips media delivery when the response has no media artifacts", async () => {
    vi.mocked(extractAgentResponse).mockResolvedValue({
      ...successfulAgentResponse(),
      mediaArtifacts: [],
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ ok: true, channel: "C123", ts: "333.444" }))
      .mockResolvedValueOnce(Response.json({ ok: true }));

    await processSlackCompletion(job(), makeEnv());

    expect(deliverMediaArtifacts).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("lets Slack derive accessible fallback text from completion blocks", async () => {
    vi.mocked(extractAgentResponse).mockResolvedValue({
      ...successfulAgentResponse(),
      mediaArtifacts: [],
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ ok: true, channel: "C123", ts: "333.444" }))
      .mockResolvedValueOnce(Response.json({ ok: true }));

    await processSlackCompletion(job(), makeEnv());

    const request = fetchMock.mock.calls[0]?.[1];
    const body = JSON.parse(String(request?.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty("text");
    expect(body.blocks).toBeDefined();
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

  it("posts nothing but still clears the reaction when an automation declines", async () => {
    vi.mocked(extractAgentResponse).mockResolvedValue(declinedAgentResponse());
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ok: true }));

    await processSlackCompletion(job({ source: "automation" }), makeEnv());

    expect(deliverMediaArtifacts).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("reactions.remove");
  });

  it("posts the interactive fallback when a session produces the sentinel", async () => {
    vi.mocked(extractAgentResponse).mockResolvedValue(declinedAgentResponse());
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ ok: true, channel: "C123", ts: "333.444" }))
      .mockResolvedValueOnce(Response.json({ ok: true }));

    await processSlackCompletion(job({ source: "session" }), makeEnv());

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("chat.postMessage");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("reactions.remove");
  });
});

describe("shouldDeclineReply", () => {
  const automation = { source: "automation", success: true } as const;

  it("accepts the sentinel regardless of case or a trailing period", () => {
    for (const textContent of ["NO_REPLY", "no_reply", "No_Reply.", "  NO_REPLY  "]) {
      expect(shouldDeclineReply(automation, declinedAgentResponse({ textContent }))).toBe(true);
    }
  });

  it("accepts an empty final message", () => {
    expect(shouldDeclineReply(automation, declinedAgentResponse({ textContent: "   " }))).toBe(
      true
    );
  });

  it("rejects a sentinel that is part of a real answer", () => {
    const response = declinedAgentResponse({
      textContent: "NO_REPLY is the sentinel you asked about.",
    });
    expect(shouldDeclineReply(automation, response)).toBe(false);
  });

  it("rejects interactive sessions so a waiting user always sees something", () => {
    expect(shouldDeclineReply({ source: "session", success: true }, declinedAgentResponse())).toBe(
      false
    );
  });

  it("rejects failed runs so the operator sees the error", () => {
    expect(
      shouldDeclineReply({ source: "automation", success: false }, declinedAgentResponse())
    ).toBe(false);
    expect(shouldDeclineReply(automation, declinedAgentResponse({ success: false }))).toBe(false);
  });

  it("rejects runs that produced artifacts outside Slack", () => {
    const withPr = declinedAgentResponse({
      artifacts: [{ type: "pr", url: "https://github.com/acme/app/pull/1", label: "PR #1" }],
    });
    expect(shouldDeclineReply(automation, withPr)).toBe(false);

    const withMedia = declinedAgentResponse({
      mediaArtifacts: [{ id: "image-1", type: "screenshot" }],
    });
    expect(shouldDeclineReply(automation, withMedia)).toBe(false);
  });
});
