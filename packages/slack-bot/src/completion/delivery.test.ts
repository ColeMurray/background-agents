import { afterEach, describe, expect, it, vi } from "vitest";
import { processSlackCompletion, shouldDeclineReply } from "./delivery";
import { extractAgentResponse } from "./extractor";
import { deliverMediaArtifacts } from "./media-upload";
import type { SlackCompletionJob } from "./job";
import type { AgentResponse } from "@open-inspect/shared/types/artifacts";
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
    CONTROL_PLANE: {
      fetch: vi.fn(async () => Response.json({ artifacts: [] })),
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

  it("suppresses an automation completion with only a coordinate/session tombstone", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const env = makeEnv({
      SLACK_KV: {
        get: vi.fn(async (key: string) =>
          key === "thread-closed:C123:111.222:session-1" ? "1" : null
        ),
      } as unknown as KVNamespace,
    });
    await expect(processSlackCompletion(job({ source: "automation" }), env)).resolves.toEqual({
      kind: "ack",
    });
    expect(extractAgentResponse).not.toHaveBeenCalled();
    expect(deliverMediaArtifacts).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
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

    expect(deliverMediaArtifacts).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
    ["events", 403, true],
    ["events", 503, true],
    ["artifacts", 404, false],
    ["artifacts", 503, false],
  ] as const)(
    "suppresses job content after protected %s status %s for success=%s",
    async (endpoint, status, success) => {
      const actual = await vi.importActual<typeof ExtractorModule>("./extractor");
      vi.mocked(extractAgentResponse).mockImplementation(actual.extractAgentResponse);
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(Response.json({ ok: true, channel: "C123", ts: "333.444" }));
      const env = makeEnv();
      const cpFetch = vi.mocked(env.CONTROL_PLANE.fetch);
      cpFetch.mockImplementation(async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith(`/${endpoint}`)) return Response.json({}, { status });
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
      await expect(
        processSlackCompletion(job({ success, error: "SECRET JOB ERROR" }), env)
      ).resolves.toEqual({ kind: status === 503 ? "retry" : "ack" });
      expect(cpFetch).toHaveBeenCalledTimes(endpoint === "events" ? 1 : 2);
      for (const [url] of cpFetch.mock.calls) {
        expect(new URL(String(url)).searchParams.get("channel")).toBe("slack:C123");
        expect(new URL(String(url)).searchParams.get("purpose")).toBe("slack-post");
      }
      expect(fetch).not.toHaveBeenCalled();
      expect(deliverMediaArtifacts).not.toHaveBeenCalled();
    }
  );

  describe.each(["events", "artifacts"] as const)("protected %s reads", (endpoint) => {
    it.each(["network", "timeout", "invalid-json", "malformed"] as const)(
      "retries %s failures without publishing or clearing the reaction",
      async (failure) => {
        const actual = await vi.importActual<typeof ExtractorModule>("./extractor");
        vi.mocked(extractAgentResponse).mockImplementation(actual.extractAgentResponse);
        const fetch = vi.spyOn(globalThis, "fetch");
        const env = makeEnv();
        vi.mocked(env.CONTROL_PLANE.fetch).mockImplementation(async (input) => {
          if (new URL(String(input)).pathname.endsWith(`/${endpoint}`)) {
            if (failure === "network") throw new Error("offline");
            if (failure === "timeout") throw new DOMException("timed out", "TimeoutError");
            if (failure === "invalid-json") return new Response("{");
            return Response.json({ invalid: true });
          }
          return Response.json({ events: [], hasMore: false });
        });

        await expect(processSlackCompletion(job(), env)).resolves.toEqual({ kind: "retry" });
        expect(fetch).not.toHaveBeenCalled();
        expect(deliverMediaArtifacts).not.toHaveBeenCalled();
      }
    );
  });

  it("publishes a retried completion once publication authority recovers", async () => {
    const actual = await vi.importActual<typeof ExtractorModule>("./extractor");
    vi.mocked(extractAgentResponse).mockImplementation(actual.extractAgentResponse);
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ ok: true, channel: "C123", ts: "333.444" }));
    const env = makeEnv();
    const cpFetch = vi.mocked(env.CONTROL_PLANE.fetch);
    cpFetch.mockResolvedValueOnce(new Response(null, { status: 503 }));
    cpFetch.mockImplementation(async (input) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("channel")).toBe("slack:C123");
      expect(url.searchParams.get("purpose")).toBe("slack-post");
      return url.pathname.endsWith("/events")
        ? Response.json({
            events: [
              {
                id: "token-1",
                type: "token",
                data: { content: "Previous prompt completed." },
                messageId: "message-1",
                createdAt: 1,
              },
            ],
            hasMore: false,
          })
        : Response.json({ artifacts: [] });
    });
    const completion = job();

    await expect(processSlackCompletion(completion, env)).resolves.toEqual({ kind: "retry" });
    expect(fetch).not.toHaveBeenCalled();
    await expect(processSlackCompletion(completion, env)).resolves.toEqual({ kind: "ack" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(fetch.mock.calls[0][0])).toContain("chat.postMessage");
    expect(String(fetch.mock.calls[0][1]?.body)).toContain("Previous prompt completed.");
    expect(String(fetch.mock.calls[1][0])).toContain("reactions.remove");
  });

  it.each(["allowed", "denied", "unavailable"] as const)(
    "gates cached completion text after missing media on a fresh %s publication proof",
    async (access) => {
      vi.mocked(extractAgentResponse).mockResolvedValue(successfulAgentResponse());
      const actual = await vi.importActual<typeof MediaUploadModule>("./media-upload");
      vi.mocked(deliverMediaArtifacts).mockImplementation(actual.deliverMediaArtifacts);
      let proofChecked = false;
      const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        expect(proofChecked).toBe(true);
        return Response.json({ ok: true, channel: "C123", ts: "333.444" });
      });
      const env = makeEnv();
      vi.mocked(env.CONTROL_PLANE.fetch).mockImplementation(async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/artifacts")) {
          proofChecked = true;
          if (access === "allowed") return Response.json({ artifacts: [] });
          return new Response(null, { status: access === "denied" ? 404 : 503 });
        }
        return new Response(null, { status: 404 });
      });

      await expect(
        processSlackCompletion(job({ error: "SECRET JOB ERROR" }), env)
      ).resolves.toEqual({ kind: access === "unavailable" ? "retry" : "ack" });
      expect(env.CONTROL_PLANE.fetch).toHaveBeenCalledTimes(access === "allowed" ? 4 : 2);
      const [proofUrl] = vi.mocked(env.CONTROL_PLANE.fetch).mock.calls[1]!;
      expect(new URL(String(proofUrl)).pathname).toBe("/sessions/session-1/artifacts");
      expect(new URL(String(proofUrl)).searchParams.get("channel")).toBe("slack:C123");
      expect(new URL(String(proofUrl)).searchParams.get("purpose")).toBe("slack-post");
      const posts = fetch.mock.calls.filter(([url]) => String(url).includes("chat.postMessage"));
      if (access === "allowed") {
        expect(posts).toHaveLength(2);
        expect(String(posts[0]?.[1]?.body)).toContain("Generated the chart.");
        expect(String(posts[1]?.[1]?.body)).toContain("could not be attached here");
        expect(fetch.mock.calls.some(([url]) => String(url).includes("reactions.remove"))).toBe(
          true
        );
      } else {
        expect(posts).toHaveLength(0);
        expect(fetch).not.toHaveBeenCalled();
      }
    }
  );

  describe.each([true, false])("final publication access for success=%s", (success) => {
    it.each([403, 404, 503])(
      "suppresses cached content after unbinding between extraction and posting: %s",
      async (status) => {
        const actual = await vi.importActual<typeof ExtractorModule>("./extractor");
        vi.mocked(extractAgentResponse).mockImplementation(actual.extractAgentResponse);
        const env = makeEnv();
        let bound = true;
        const cpFetch = vi.mocked(env.CONTROL_PLANE.fetch).mockImplementation(async (input) => {
          if (new URL(String(input)).pathname.endsWith("/events")) {
            return Response.json({
              events: success
                ? [
                    {
                      id: "secret",
                      type: "token",
                      data: { content: "SECRET CONTENT" },
                      messageId: "message-1",
                      createdAt: 1,
                    },
                  ]
                : [],
              hasMore: false,
            });
          }
          if (!bound) return new Response(null, { status });
          // The protected artifacts read succeeds, then the channel is unbound.
          bound = false;
          return Response.json({ artifacts: [] });
        });
        const fetch = vi.spyOn(globalThis, "fetch");

        await expect(
          processSlackCompletion(job({ success, error: "SECRET JOB ERROR" }), env)
        ).resolves.toEqual({ kind: status === 503 ? "retry" : "ack" });

        expect(cpFetch).toHaveBeenCalledTimes(3);
        const [proofUrl, proofInit] = cpFetch.mock.calls[2]!;
        expect(new URL(String(proofUrl)).searchParams.get("channel")).toBe("slack:C123");
        expect(new URL(String(proofUrl)).searchParams.get("purpose")).toBe("slack-post");
        expect(new Headers(proofInit?.headers).get("X-OpenInspect-Service-Signature")).toMatch(
          /^sig1\./
        );
        expect(fetch).not.toHaveBeenCalled();
        expect(deliverMediaArtifacts).not.toHaveBeenCalled();
      }
    );
  });

  it.each([404, 503])(
    "does not replay shared media when the final text proof fails: %s",
    async (status) => {
      const env = makeEnv();
      vi.mocked(extractAgentResponse).mockResolvedValue(successfulAgentResponse());
      vi.mocked(deliverMediaArtifacts).mockImplementation(async (input) => {
        input.onShareAttempt();
        vi.mocked(env.CONTROL_PLANE.fetch).mockResolvedValue(new Response(null, { status }));
        return { uploaded: 1, failed: 0, omitted: 0 };
      });
      const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ok: true }));

      await expect(processSlackCompletion(job(), env)).resolves.toEqual({ kind: "ack" });

      expect(deliverMediaArtifacts).toHaveBeenCalledOnce();
      expect(fetch).toHaveBeenCalledOnce();
      expect(String(fetch.mock.calls[0]?.[0])).toContain("reactions.remove");
    }
  );

  it("rechecks authority for the unavailable-media notice after posting text", async () => {
    const env = makeEnv();
    vi.mocked(extractAgentResponse).mockResolvedValue(successfulAgentResponse());
    vi.mocked(deliverMediaArtifacts).mockResolvedValue({ uploaded: 0, failed: 1, omitted: 0 });
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(async () => {
        vi.mocked(env.CONTROL_PLANE.fetch).mockResolvedValue(new Response(null, { status: 404 }));
        return Response.json({ ok: true, channel: "C123", ts: "333.444" });
      })
      .mockResolvedValueOnce(Response.json({ ok: true }));

    await expect(processSlackCompletion(job(), env)).resolves.toEqual({ kind: "ack" });

    expect(env.CONTROL_PLANE.fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(fetch.mock.calls[0]?.[0])).toContain("chat.postMessage");
    expect(String(fetch.mock.calls[1]?.[0])).toContain("reactions.remove");
  });

  it("does not replay accepted media if the following closure check throws", async () => {
    vi.mocked(extractAgentResponse).mockResolvedValue(successfulAgentResponse());
    const actual = await vi.importActual<typeof MediaUploadModule>("./media-upload");
    vi.mocked(deliverMediaArtifacts).mockImplementation(actual.deliverMediaArtifacts);
    const env = makeEnv();
    vi.mocked(env.CONTROL_PLANE.fetch).mockResolvedValueOnce(
      new Response("png-bytes", {
        headers: { "Content-Type": "image/png", "Content-Length": "9" },
      })
    );
    let shared = false;
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({ ok: true, upload_url: "https://files.slack.com/upload/one", file_id: "F1" })
      )
      .mockResolvedValueOnce(new Response("OK"))
      .mockImplementationOnce(async () => {
        shared = true;
        return Response.json({ ok: true, files: [{ id: "F1" }] });
      });
    vi.spyOn(ThreadSessionStore, "isThreadSessionClosed").mockImplementation(async () => {
      if (shared) throw new Error("KV unavailable after share");
      return false;
    });

    await expect(processSlackCompletion(job(), env)).resolves.toEqual({ kind: "ack" });
    expect(shared).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(String(fetch.mock.calls[2]?.[0])).toContain("files.completeUploadExternal");
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
