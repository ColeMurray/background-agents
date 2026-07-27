import { afterEach, describe, expect, it, vi } from "vitest";
import type { Environment } from "@open-inspect/shared";
import type { Env } from "../types";
import { createSession, sendPrompt } from "./control-plane-client";
import { OUTBOUND_REQUEST_TIMEOUT_MS } from "../request-options";

function makeEnv(fetch: ReturnType<typeof vi.fn>): Env {
  return {
    CONTROL_PLANE: { fetch } as unknown as Fetcher,
    SERVICE_AUTH_SECRET: "test-secret",
    LOG_LEVEL: "error",
  } as Env;
}

const target = {
  kind: "repository" as const,
  repo: {
    id: "acme/app",
    owner: "acme",
    name: "app",
    fullName: "acme/app",
    displayName: "acme/app",
    description: "Application repository",
    defaultBranch: "main",
    private: true,
  },
};

const environmentTarget = {
  kind: "environment" as const,
  environment: {
    id: "env-1",
    name: "Production triage",
    description: null,
    prebuildEnabled: true,
    createdAt: 1,
    updatedAt: 2,
    repositories: [{ repoOwner: "acme", repoName: "app", repoId: 123, baseBranch: "main" }],
  } satisfies Environment,
};

function okJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function parseRequestBody(fetch: ReturnType<typeof vi.fn>, index = 0): unknown {
  const [, init] = fetch.mock.calls[index] as [RequestInfo | URL, RequestInit];
  return JSON.parse(init.body as string);
}

describe("control plane client timeouts", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("aborts session creation after the control plane timeout", async () => {
    const controller = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    });
    const result = createSession(makeEnv(fetch), {
      target,
      model: "openai/gpt-5.4",
    });

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    controller.abort(new DOMException("Timed out", "TimeoutError"));

    await expect(result).resolves.toBeNull();
    expect(timeoutSpy).toHaveBeenCalledWith(OUTBOUND_REQUEST_TIMEOUT_MS);
    expect(fetch.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });

  it("aborts prompt delivery after the control plane timeout", async () => {
    const controller = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    });
    const result = sendPrompt(makeEnv(fetch), {
      sessionId: "session-1",
      content: "Fix it",
      authorId: "slack:U123",
    });

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    controller.abort(new DOMException("Timed out", "TimeoutError"));

    await expect(result).resolves.toEqual({ ok: false, reason: "transient" });
    expect(timeoutSpy).toHaveBeenCalledWith(OUTBOUND_REQUEST_TIMEOUT_MS);
    expect(fetch.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });

  it("classifies only not-found prompt responses as stale", async () => {
    const notFoundFetch = vi.fn(async () => new Response(null, { status: 404 }));
    const serverErrorFetch = vi.fn(async () => new Response(null, { status: 503 }));

    await expect(
      sendPrompt(makeEnv(notFoundFetch), {
        sessionId: "missing-session",
        content: "Fix it",
        authorId: "slack:U123",
      })
    ).resolves.toEqual({ ok: false, reason: "stale" });
    await expect(
      sendPrompt(makeEnv(serverErrorFetch), {
        sessionId: "session-1",
        content: "Fix it",
        authorId: "slack:U123",
      })
    ).resolves.toEqual({ ok: false, reason: "transient" });
  });
});

describe("control plane client request payloads", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates repository sessions with target, model, and branch — identity stays out of the body", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      okJson({ sessionId: "session-1", status: "created" })
    );

    await expect(
      createSession(makeEnv(fetch), {
        target,
        model: "openai/gpt-5.4",
        reasoningEffort: "high",
        branch: "feature/slack-images",
        slackUserId: "U123",
        actorDisplayName: "Ada Lovelace",
        actorEmail: "ada@example.com",
        traceId: "trace-1",
      })
    ).resolves.toEqual({ sessionId: "session-1", status: "created" });

    const [url, init] = fetch.mock.calls[0] as [RequestInfo | URL, RequestInit];
    expect(url).toBe("https://internal/sessions");
    expect(init.method).toBe("POST");
    // The Slack actor rides the signed X-OpenInspect-Actor header, never the
    // body — the control plane rejects body identity fields from verified
    // callers. Only display fields stay body-carried.
    expect(parseRequestBody(fetch)).toEqual({
      repoOwner: "acme",
      repoName: "app",
      branch: "feature/slack-images",
      model: "openai/gpt-5.4",
      reasoningEffort: "high",
      actorDisplayName: "Ada Lovelace",
      actorEmail: "ada@example.com",
    });
  });

  it("creates environment sessions without repository or branch fields", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      okJson({ sessionId: "session-1", status: "created" })
    );

    await createSession(makeEnv(fetch), {
      target: environmentTarget,
      model: "anthropic/claude-sonnet-4-6",
      branch: "ignored-for-environments",
    });

    expect(parseRequestBody(fetch)).toEqual({
      environmentId: "env-1",
      model: "anthropic/claude-sonnet-4-6",
    });
  });

  it("sends prompt attachment references only when present", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      okJson({ messageId: "message-1", status: "queued" })
    );

    await sendPrompt(makeEnv(fetch), {
      sessionId: "session-1",
      content: "Use the screenshot",
      authorId: "slack:U123",
      attachments: [{ attachmentId: "att-1", name: "screenshot.png" }],
    });
    await sendPrompt(makeEnv(fetch), {
      sessionId: "session-1",
      content: "No attachments",
      authorId: "slack:U123",
      attachments: [],
    });

    expect(parseRequestBody(fetch, 0)).toEqual({
      content: "Use the screenshot",
      source: "slack",
      attachments: [{ attachmentId: "att-1", name: "screenshot.png" }],
    });
    expect(parseRequestBody(fetch, 1)).toEqual({
      content: "No attachments",
      source: "slack",
    });
  });
});

describe("service credential headers", () => {
  function makeServiceEnv(fetch: ReturnType<typeof vi.fn>): Env {
    return {
      ...makeEnv(fetch),
      SERVICE_AUTH_SECRET: "slack-service-secret",
    } as Env;
  }

  function sentHeaders(fetch: ReturnType<typeof vi.fn>): Record<string, string> {
    return (fetch.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
  }

  it("signs session creation with sig1 and asserts the Slack actor", async () => {
    const fetch = vi.fn(
      async () => new Response(JSON.stringify({ sessionId: "s1", status: "created" }))
    );
    await createSession(makeServiceEnv(fetch), {
      target,
      model: "openai/gpt-5.4",
      slackUserId: "U0123",
    });

    const headers = sentHeaders(fetch);
    expect(headers["X-OpenInspect-Service"]).toBe("slack-bot");
    expect(headers["X-OpenInspect-Service-Signature"]).toMatch(/^sig1\./);
    expect(headers["X-OpenInspect-Actor"]).toBe("slack:U0123");
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("signs prompts with the author as the asserted actor", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ messageId: "m1" })));
    await sendPrompt(makeServiceEnv(fetch), {
      sessionId: "session-1",
      content: "Fix it",
      authorId: "slack:U456",
    });

    const headers = sentHeaders(fetch);
    expect(headers["X-OpenInspect-Service-Signature"]).toMatch(/^sig1\./);
    expect(headers["X-OpenInspect-Actor"]).toBe("slack:U456");
  });

  it("sends no request at all when SERVICE_AUTH_SECRET is unset", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ messageId: "m1" })));
    const env = {
      CONTROL_PLANE: { fetch } as unknown as Fetcher,
      LOG_LEVEL: "error",
    } as Env;

    const result = await sendPrompt(env, {
      sessionId: "session-1",
      content: "Fix it",
      authorId: "slack:U456",
    });

    expect(result).toEqual({ ok: false, reason: "transient" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
