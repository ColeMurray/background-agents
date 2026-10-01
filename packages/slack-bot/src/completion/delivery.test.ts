import { afterEach, describe, expect, it, vi } from "vitest";
import { processSlackCompletion, shouldDeclineReply } from "./delivery";
import { extractAgentResponse } from "./extractor";
import { deliverMediaArtifacts } from "./media-upload";
import type { SlackCompletionJob } from "./job";
import type { AgentResponse } from "@open-inspect/shared/types/artifacts";
import { ProtectedReadError } from "@open-inspect/shared/completion/extractor";
import * as Slack from "@open-inspect/shared/slack";
import * as ThreadSessionStore from "../sessions/thread-session-store";
import * as CompletionBlocks from "./blocks";
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
    SLACK_KV: { get: vi.fn(async () => null) } as unknown as KVNamespace,
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

    await expect(processSlackCompletion(job(), env)).resolves.toEqual({ kind: "ack" });

    expect(extractAgentResponse).toHaveBeenCalledWith(
      env,
      "session-1",
      "message-1",
      "C123",
      "trace-1"
    );

    expect(deliverMediaArtifacts).toHaveBeenCalledWith({
      env,
      sessionId: "session-1",
      messageId: "message-1",
      channel: "C123",
      threadTs: "111.222",
      artifacts: [{ id: "image-1", type: "screenshot" }],
      traceId: "trace-1",
      onShareAttempt: expect.any(Function),
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("chat.postMessage");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("chat.postMessage");
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain("reactions.remove");
  });

  it("suppresses a queued completion after its thread mapping closes", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const env = makeEnv({
      SLACK_KV: {
        get: vi.fn(async () => ({
          sessionId: "session-1",
          repoId: "acme/app",
          repoFullName: "acme/app",
          model: "openai/gpt-5.4",
          createdAt: 1,
          teamId: null,
          closed: true,
        })),
      } as unknown as KVNamespace,
    });
    await expect(processSlackCompletion(job(), env)).resolves.toEqual({ kind: "ack" });
    expect(extractAgentResponse).not.toHaveBeenCalled();
    expect(deliverMediaArtifacts).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("suppresses an automation completion with only a coordinate/session tombstone", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const env = makeEnv({
      SLACK_KV: {
        get: vi.fn(async (key: string) =>
          key === "thread-closed:C123:111.222:session-1" ? "1" : null
        ),
      } as unknown as KVNamespace,
    });
    await processSlackCompletion(job({ source: "automation" }), env);
    expect(extractAgentResponse).not.toHaveBeenCalled();
    expect(deliverMediaArtifacts).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
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

  it("validates media before the ordinary completion post and stops after a failed post", async () => {
    vi.mocked(extractAgentResponse).mockResolvedValue(successfulAgentResponse());
    vi.mocked(deliverMediaArtifacts).mockResolvedValue({ uploaded: 1, failed: 0, omitted: 0 });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ ok: false, error: "channel_not_found" }))
      .mockResolvedValueOnce(Response.json({ ok: true }));

    await processSlackCompletion(job(), makeEnv());

    expect(deliverMediaArtifacts).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("reactions.remove");
  });

  it("retries when extraction throws before publication", async () => {
    vi.mocked(extractAgentResponse).mockRejectedValue(new Error("control plane unavailable"));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ok: true }));

    await expect(processSlackCompletion(job(), makeEnv())).resolves.toEqual({ kind: "retry" });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retries a closure lookup failure before publishing anything", async () => {
    vi.spyOn(ThreadSessionStore, "isThreadSessionClosed").mockRejectedValueOnce(
      new Error("KV unavailable")
    );
    const fetch = vi.spyOn(globalThis, "fetch");
    await expect(processSlackCompletion(job(), makeEnv())).resolves.toEqual({ kind: "retry" });
    expect(extractAgentResponse).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps the reaction untouched when preparation fails after successful reads", async () => {
    vi.mocked(extractAgentResponse).mockResolvedValue({
      ...successfulAgentResponse(),
      mediaArtifacts: [],
    });
    vi.spyOn(CompletionBlocks, "buildCompletionBlocks").mockImplementation(() => {
      throw new Error("block preparation failed");
    });
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ok: true }));
    await expect(processSlackCompletion(job(), makeEnv())).resolves.toEqual({ kind: "retry" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    "events-403",
    "events-404",
    "artifacts-403",
    "artifacts-404",
    "events-503",
    "artifacts-503",
    "events-network",
    "artifacts-network",
    "events-malformed",
    "artifacts-malformed",
    "events-invalid-JSON",
    "artifacts-invalid-JSON",
  ])(
    "suppresses failed-job errors and success metadata when protected reads fail: %s",
    async (failure) => {
      const actual = await vi.importActual<typeof ExtractorModule>("./extractor");
      vi.mocked(extractAgentResponse).mockImplementation(actual.extractAgentResponse);
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(Response.json({ ok: true, channel: "C123", ts: "333.444" }));
      const env = makeEnv();
      const cpFetch = vi.mocked(env.CONTROL_PLANE.fetch);
      cpFetch.mockImplementation(async (input) => {
        const url = new URL(String(input));
        const endpoint = url.pathname.endsWith("/events") ? "events" : "artifacts";
        if (failure.startsWith(endpoint)) {
          if (failure.endsWith("network")) throw new Error("CP unavailable");
          if (failure.endsWith("invalid-JSON")) return new Response("{");
          const status = Number(failure.split("-")[1]);
          return Number.isFinite(status)
            ? Response.json({}, { status })
            : Response.json({ invalid: true });
        }
        return Response.json({
          events: [
            {
              id: "secret",
              type: "token",
              data: { content: "SECRET CONTENT" },
              messageId: "message-1",
              createdAt: 1,
            },
          ],
          hasMore: false,
        });
      });
      for (const success of [false, true]) {
        await expect(
          processSlackCompletion(
            job({
              success,
              error: "SECRET JOB ERROR",
              context: { repoFullName: "private/repository", model: "openai/gpt-5.4" },
            }),
            env
          )
        ).resolves.toEqual({ kind: /-(403|404)$/.test(failure) ? "ack" : "retry" });
      }
      expect(cpFetch).toHaveBeenCalled();
      for (const [url] of cpFetch.mock.calls) {
        expect(new URL(String(url)).searchParams.get("purpose")).toBe("slack-post");
      }
      expect(fetch).not.toHaveBeenCalled();
      expect(deliverMediaArtifacts).not.toHaveBeenCalled();
    }
  );

  it.each([403, 404, 503, undefined])(
    "suppresses all job content and classifies a pre-share media read failure: %s",
    async (status) => {
      vi.mocked(extractAgentResponse).mockResolvedValue(successfulAgentResponse());
      vi.mocked(deliverMediaArtifacts).mockRejectedValue(
        new ProtectedReadError("media read failed", status)
      );
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(Response.json({ ok: true, channel: "C123", ts: "333.444" }));
      await expect(
        processSlackCompletion(job({ error: "SECRET JOB ERROR" }), makeEnv())
      ).resolves.toEqual({
        kind: status === 403 || status === 404 ? "ack" : "retry",
      });
      expect(fetch).not.toHaveBeenCalled();
    }
  );

  it("does not replay a protected-read failure after a media sharing attempt", async () => {
    vi.mocked(extractAgentResponse).mockResolvedValue(successfulAgentResponse());
    vi.mocked(deliverMediaArtifacts).mockImplementation(async ({ onShareAttempt }) => {
      onShareAttempt();
      throw new ProtectedReadError("later failure", 503);
    });
    const fetch = vi.spyOn(globalThis, "fetch");

    await expect(processSlackCompletion(job(), makeEnv())).resolves.toEqual({ kind: "ack" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not replay accepted media if the following closure check throws", async () => {
    vi.mocked(extractAgentResponse).mockResolvedValue(successfulAgentResponse());
    vi.mocked(deliverMediaArtifacts).mockImplementation(async ({ onShareAttempt }) => {
      onShareAttempt();
      return { uploaded: 1, failed: 0, omitted: 0 };
    });
    vi.spyOn(ThreadSessionStore, "isThreadSessionClosed")
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error("KV unavailable after share"));
    const fetch = vi.spyOn(globalThis, "fetch");

    await expect(processSlackCompletion(job(), makeEnv())).resolves.toEqual({ kind: "ack" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "does not replay an ambiguous text post for job success=%s",
    async (success) => {
      vi.mocked(extractAgentResponse).mockResolvedValue({
        ...successfulAgentResponse(),
        textContent: success ? "Finished." : "",
        mediaArtifacts: [],
      });
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValueOnce(new Error("Slack accepted the post but the response was lost"))
        .mockResolvedValueOnce(Response.json({ ok: true }));

      await expect(processSlackCompletion(job({ success }), makeEnv())).resolves.toEqual({
        kind: "ack",
      });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(String(fetch.mock.calls[0]?.[0])).toContain("chat.postMessage");
      expect(String(fetch.mock.calls[1]?.[0])).toContain("reactions.remove");
    }
  );

  it.each(["blocks", "error-message"])(
    "does not mistake an unexpected %s post exception for a safe read retry",
    async (post) => {
      vi.mocked(extractAgentResponse).mockResolvedValue({
        ...successfulAgentResponse(),
        textContent: post === "blocks" ? "Finished." : "",
        mediaArtifacts: [],
      });
      vi.spyOn(Slack, post === "blocks" ? "postBlocks" : "postMessage").mockRejectedValue(
        new ProtectedReadError("unexpected error after publication attempt", 503)
      );
      const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ok: true }));

      await expect(
        processSlackCompletion(job({ success: post === "blocks" }), makeEnv())
      ).resolves.toEqual({ kind: "ack" });
      expect(fetch).toHaveBeenCalledOnce();
      expect(String(fetch.mock.calls[0]?.[0])).toContain("reactions.remove");
    }
  );

  it("posts nothing but still clears the reaction when an automation declines", async () => {
    vi.mocked(extractAgentResponse).mockResolvedValue(declinedAgentResponse());
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ok: true }));

    await expect(processSlackCompletion(job({ source: "automation" }), makeEnv())).resolves.toEqual(
      { kind: "ack" }
    );

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
