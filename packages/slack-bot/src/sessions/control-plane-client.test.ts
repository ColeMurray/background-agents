import { afterEach, describe, expect, it, vi } from "vitest";
import type { Environment } from "@open-inspect/shared/types/environments";
import type { ControlPlaneEnv } from "../internal-auth";
import { checkPublicationAccess, createSession, sendPrompt } from "./control-plane-client";
import { OUTBOUND_REQUEST_TIMEOUT_MS } from "../request-options";
import { sha256Hex, verifyServiceSignature } from "@open-inspect/shared/service-auth";

function makeEnv(fetch: ControlPlaneEnv["CONTROL_PLANE"]["fetch"]): ControlPlaneEnv {
  return {
    CONTROL_PLANE: { fetch },
    SERVICE_AUTH_SECRET: "test-secret",
  };
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

const noRepositoryTarget = { kind: "none" as const };

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
      channel: "C123",
      content: "Fix it",
      authorId: "slack:U123",
    });

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    controller.abort(new DOMException("Timed out", "TimeoutError"));

    await expect(result).resolves.toEqual({ ok: false, reason: "transient" });
    expect(timeoutSpy).toHaveBeenCalledWith(OUTBOUND_REQUEST_TIMEOUT_MS);
    expect(fetch.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });

  it.each([
    [403, "forbidden"],
    [404, "stale"],
    [503, "transient"],
  ] as const)("classifies prompt status %s as %s without retrying", async (status, reason) => {
    const fetch = vi.fn(async () => new Response(null, { status }));
    await expect(
      sendPrompt(makeEnv(fetch), {
        sessionId: "session-1",
        channel: "C123",
        content: "Fix it",
        authorId: "slack:U123",
      })
    ).resolves.toEqual({ ok: false, reason });
    expect(fetch).toHaveBeenCalledOnce();
  });
});

describe("prompt channel scope", () => {
  it.each([400, 403, 404, 503])(
    "distinguishes a channel-wide scope refusal at %s",
    async (status) => {
      const fetch = vi.fn(async () => okJson({ code: "slack_channel_scope_denied" }, status));
      expect(
        await sendPrompt(makeEnv(fetch), {
          sessionId: "session-1",
          channel: "C123",
          content: "Do not forward",
          authorId: "slack:U123",
        })
      ).toEqual({ ok: false, reason: "channel_scope_denied" });
    }
  );
});

describe("publication access", () => {
  it.each([
    [200, { artifacts: [] }, "allowed"],
    [403, { error: "Forbidden" }, "denied"],
    [404, { error: "Session not found" }, "denied"],
    [503, {}, "unavailable"],
    [200, { invalid: true }, "unavailable"],
    ["invalid-json", null, "unavailable"],
    ["network", null, "unavailable"],
  ] as const)(
    "classifies a protected status %s without inferring access from cached metadata",
    async (status, body, result) => {
      const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
        if (status === "network") throw new Error("offline");
        return status === "invalid-json" ? new Response("{") : okJson(body, status);
      });
      expect(await checkPublicationAccess(makeEnv(fetch), "s1", "C1", "trace")).toBe(result);
      if (result !== "allowed") return;
      const [url, request] = fetch.mock.calls[0];
      expect(new URL(String(url)).pathname).toBe("/sessions/s1/artifacts");
      expect(new URL(String(url)).searchParams.get("channel")).toBe("slack:C1");
      expect(new URL(String(url)).searchParams.get("purpose")).toBe("slack-post");
      expect(request?.method).toBe("GET");
      const headers = new Headers(request?.headers);
      expect(headers.get("X-OpenInspect-Service")).toBe("slack-bot");
      expect(headers.get("X-OpenInspect-Service-Signature")).toMatch(/^sig1\./);
      expect(headers.get("X-OpenInspect-Actor")).toBeNull();
      expect(headers.get("x-trace-id")).toBe("trace");
    }
  );
});

describe("control plane client request payloads", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["team-a", null])("sends explicit team scope %s on launch", async (teamId) => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      okJson({ sessionId: "s1", status: "created" })
    );
    await createSession(makeEnv(fetch), { target, model: "openai/gpt-5.4", teamId });
    expect(parseRequestBody(fetch)).toMatchObject({ teamId });
  });

  it.each([
    [403, { code: "session_action_denied", reason_code: "not_member" }],
    [403, { code: "not_member" }],
    [409, { code: "target_team_missing_grant", repository: "acme/app" }],
  ] as const)("preserves create refusal details at %s", async (status, body) => {
    const fetch = vi.fn(async () => okJson(body, status));
    expect(await createSession(makeEnv(fetch), { target, model: "openai/gpt-5.4" })).toEqual({
      error: {
        status,
        code: body.code,
        reasonCode: "reason_code" in body ? body.reason_code : undefined,
        repository: "repository" in body ? body.repository : undefined,
      },
    });
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

  it("creates no-repository sessions with explicit null repository fields", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      okJson({ sessionId: "session-1", status: "created" })
    );

    await createSession(makeEnv(fetch), {
      target: noRepositoryTarget,
      model: "anthropic/claude-sonnet-4-6",
      branch: "ignored-without-a-repository",
    });

    expect(parseRequestBody(fetch)).toEqual({
      repoOwner: null,
      repoName: null,
      model: "anthropic/claude-sonnet-4-6",
    });
  });

  it("sends prompt attachment references only when present", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      okJson({ messageId: "message-1", status: "queued" })
    );

    await sendPrompt(makeEnv(fetch), {
      sessionId: "session-1",
      channel: "C123",
      content: "Use the screenshot",
      authorId: "slack:U123",
      model: "openai/gpt-5.6-sol",
      reasoningEffort: "high",
      attachments: [{ attachmentId: "att-1", name: "screenshot.png" }],
    });
    await sendPrompt(makeEnv(fetch), {
      sessionId: "session-1",
      channel: "C123",
      content: "No attachments",
      authorId: "slack:U123",
      attachments: [],
    });

    expect(parseRequestBody(fetch, 0)).toEqual({
      content: "Use the screenshot",
      source: "slack",
      model: "openai/gpt-5.6-sol",
      reasoningEffort: "high",
      attachments: [{ attachmentId: "att-1", name: "screenshot.png" }],
    });
    expect(parseRequestBody(fetch, 1)).toEqual({
      content: "No attachments",
      source: "slack",
    });
  });
});

describe("service credential headers", () => {
  function makeServiceEnv(fetch: ControlPlaneEnv["CONTROL_PLANE"]["fetch"]): ControlPlaneEnv {
    return {
      ...makeEnv(fetch),
      SERVICE_AUTH_SECRET: "slack-service-secret",
    };
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

  it("signs prompts with the author and channel coordinate", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ messageId: "m1" })));
    await sendPrompt(makeServiceEnv(fetch), {
      sessionId: "session-1",
      channel: "C123",
      content: "Fix it",
      authorId: "slack:U456",
    });

    const headers = sentHeaders(fetch);
    expect(headers["X-OpenInspect-Service-Signature"]).toMatch(/^sig1\./);
    expect(headers["X-OpenInspect-Actor"]).toBe("slack:U456");
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(url).searchParams.get("channel")).toBe("slack:C123");
    const signed = {
      signatureHeader: headers["X-OpenInspect-Service-Signature"],
      service: "slack-bot" as const,
      secret: "slack-service-secret",
      method: "POST",
      url,
      bodySha256Hex: await sha256Hex(String(init.body)),
      actor: "slack:U456",
    };
    expect(await verifyServiceSignature(signed)).toMatchObject({ ok: true });
    const changed = new URL(url);
    changed.searchParams.set("channel", "slack:C_OTHER");
    expect(await verifyServiceSignature({ ...signed, url: changed.toString() })).toMatchObject({
      ok: false,
    });
  });

  it("sends no request at all when SERVICE_AUTH_SECRET is unset", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ messageId: "m1" })));
    const env = {
      CONTROL_PLANE: { fetch },
    };

    const result = await sendPrompt(env, {
      sessionId: "session-1",
      channel: "C123",
      content: "Fix it",
      authorId: "slack:U456",
    });

    expect(result).toEqual({ ok: false, reason: "transient" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
