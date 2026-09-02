import { buildServiceAuthHeaders, type ServiceName } from "@open-inspect/shared/service-auth";
import { createExecutionContext, env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import type { Env } from "../../src/types";
import { cleanD1Tables } from "./cleanup";
import {
  getSetCookies,
  initNamedSession,
  queryDO,
  seedMessage,
  seedSandboxAuthHash,
  serviceFetch,
} from "./helpers";

const MP4_BYTES = Uint8Array.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
  0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32,
]);

const SERVICE_SECRETS: Record<ServiceName, string> = {
  web: "test-service-secret-web",
  "github-bot": "test-service-secret-github-bot",
  "slack-bot": "test-service-secret-slack-bot",
  "linear-bot": "test-service-secret-linear-bot",
};

function fetchWorker(request: Request, requestEnv: Env = env): Promise<Response> {
  return worker.fetch(request, requestEnv, createExecutionContext());
}

async function signedRequest(input: {
  url: string;
  method?: string;
  service: ServiceName;
  body?: string;
  actor?: string;
  headers?: Record<string, string>;
}): Promise<Request> {
  const method = input.method ?? "GET";
  return new Request(input.url, {
    method,
    headers: {
      ...(input.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...input.headers,
      ...(await buildServiceAuthHeaders({
        service: input.service,
        secret: SERVICE_SECRETS[input.service],
        method,
        url: input.url,
        body: input.body,
        actor: input.actor,
      })),
    },
    body: input.body,
  });
}

function expectCommonResponseHeaders(response: Response, traceId: string): void {
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  expect(response.headers.get("x-request-id")).toBeTruthy();
  expect(response.headers.get("x-trace-id")).toBe(traceId);
}

async function uploadVideoFixture(): Promise<{ artifactId: string; sessionName: string }> {
  const sessionName = `response-compat-${crypto.randomUUID()}`;
  const sandboxToken = `sandbox-${crypto.randomUUID()}`;
  const { stub } = await initNamedSession(sessionName);
  await seedSandboxAuthHash(stub, {
    authToken: sandboxToken,
    sandboxId: "sandbox-response-compat",
  });

  const participants = await queryDO<{ id: string }>(
    stub,
    "SELECT id FROM participants WHERE user_id = ?",
    "user-1"
  );
  const participantId = participants[0]?.id;
  if (!participantId) throw new Error("Missing media fixture participant");
  await seedMessage(stub, {
    id: `message-${crypto.randomUUID()}`,
    authorId: participantId,
    content: "Record response compatibility",
    source: "sandbox",
    status: "processing",
    createdAt: Date.now() - 1_000,
    startedAt: Date.now() - 500,
  });

  const formData = new FormData();
  formData.append("file", new File([MP4_BYTES], "recording.mp4", { type: "video/mp4" }));
  formData.append("artifactType", "video");
  formData.append("caption", "Response compatibility recording");
  formData.append("durationMs", "2500");
  formData.append("recordingStartedAt", "1000");
  formData.append("recordingEndedAt", "3500");
  formData.append("dimensions", '{"width":1280,"height":720}');
  formData.append("truncated", "false");
  formData.append("hasAudio", "false");

  const response = await SELF.fetch(`https://test.local/sessions/${sessionName}/media`, {
    method: "POST",
    headers: { Authorization: `Bearer ${sandboxToken}` },
    body: formData,
  });
  expect(response.status).toBe(201);
  const body = await response.json<{ artifactId: string }>();
  return { artifactId: body.artifactId, sessionName };
}

beforeEach(cleanD1Tables);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ordinary HTTP response compatibility", () => {
  it("keeps a missing database binding failure undecorated at the Worker boundary", async () => {
    const response = await fetchWorker(
      new Request("https://test.local/health", {
        headers: { "x-trace-id": "missing-db-trace" },
      }),
      { ...env, DB: undefined } as unknown as Env
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "Database not configured" });
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(response.headers.get("x-request-id")).toBeNull();
    expect(response.headers.get("x-trace-id")).toBeNull();
    expect(response.headers.get("Cache-Control")).toBeNull();
  });

  it("decorates an SCM provider rejection with the common response headers", async () => {
    const traceId = "scm-rejection-trace";
    const request = await signedRequest({
      url: "https://test.local/repos",
      service: "slack-bot",
      headers: { "x-trace-id": traceId },
    });

    const response = await fetchWorker(request, { ...env, SCM_PROVIDER: "gitlab" } as Env);

    expect(response.status).toBe(501);
    await expect(response.json()).resolves.toEqual({
      error: "SCM provider 'gitlab' is not implemented in this deployment.",
    });
    expectCommonResponseHeaders(response, traceId);
    expect(response.headers.get("Cache-Control")).toBeNull();
  });

  it("refuses an unsupported provider before enrolling a verified service actor", async () => {
    const request = await signedRequest({
      url: "https://test.local/sessions",
      method: "POST",
      service: "slack-bot",
      actor: "slack:U-UNSUPPORTED-PROVIDER",
      body: JSON.stringify({ title: "Never created", model: "anthropic/claude-haiku-4-5" }),
    });

    const response = await fetchWorker(request, { ...env, SCM_PROVIDER: "gitlab" } as Env);

    expect(response.status).toBe(501);
    await expect(
      env.DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM users) AS users,
           (SELECT COUNT(*) FROM user_identities) AS identities,
           (SELECT COUNT(*) FROM user_role_assignments) AS assignments`
      ).first<{ users: number; identities: number; assignments: number }>()
    ).resolves.toEqual({ users: 0, identities: 0, assignments: 0 });
  });

  it("applies a matched route's cache policy to an authentication rejection", async () => {
    const traceId = "route-cache-trace";
    const response = await SELF.fetch("https://test.local/roles", {
      headers: { "x-trace-id": traceId },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expectCommonResponseHeaders(response, traceId);
  });

  it("maps a handler HttpError to JSON while retaining common headers", async () => {
    const traceId = "http-error-trace";
    const body = JSON.stringify({
      environmentId: `missing-${crypto.randomUUID()}`,
      title: "Missing environment compatibility request",
      model: "anthropic/claude-haiku-4-5",
    });
    const request = await signedRequest({
      url: "https://test.local/sessions",
      method: "POST",
      service: "slack-bot",
      actor: `slack:response-compat-${crypto.randomUUID()}`,
      headers: { "x-trace-id": traceId },
      body,
    });

    const response = await fetchWorker(request);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: expect.stringMatching(/^Environment not found: missing-/),
    });
    expectCommonResponseHeaders(response, traceId);
  });

  it("preserves repeated Set-Cookie headers on a browser-auth redirect", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "https://github.com/login/oauth/access_token") {
        return Response.json({ access_token: "response-compat-token", token_type: "bearer" });
      }
      if (url === "https://api.github.com/user") {
        return Response.json({
          id: 908_172,
          login: "response-compat-user",
          name: "Response Compat User",
          avatar_url: "https://avatars.example/response-compat-user",
        });
      }
      if (url.startsWith("https://api.github.com/user/emails")) {
        return Response.json([
          {
            email: "response-compat@example.com",
            primary: true,
            verified: true,
            visibility: "private",
          },
        ]);
      }
      throw new Error(`Unexpected external request: ${url}`);
    });

    const initiationBody = JSON.stringify({
      provider: "github",
      callbackURL: "/after-response-compat",
      disableRedirect: true,
    });
    const initiation = await fetchWorker(
      await signedRequest({
        url: "https://test.local/api/auth/sign-in/social",
        method: "POST",
        service: "web",
        body: initiationBody,
      })
    );
    expect(initiation.status).toBe(200);
    const providerUrl = new URL((await initiation.json<{ url: string }>()).url);
    const state = providerUrl.searchParams.get("state");
    expect(state).toBeTruthy();
    const stateCookie = getSetCookies(initiation.headers).find((value) =>
      value.startsWith("__Secure-openinspect.state=")
    );
    expect(stateCookie).toBeTruthy();

    const callbackUrl = `https://test.local/api/auth/callback/github?code=response-compat-code&state=${encodeURIComponent(state ?? "")}`;
    const traceId = "browser-redirect-trace";
    const callback = await fetchWorker(
      await signedRequest({
        url: callbackUrl,
        service: "web",
        headers: {
          Cookie: stateCookie?.split(";", 1)[0] ?? "",
          "x-trace-id": traceId,
        },
      })
    );

    expect(callback.status).toBe(302);
    expect(callback.headers.get("Location")).toBe("/after-response-compat");
    const callbackCookies = getSetCookies(callback.headers);
    expect(callbackCookies.some((value) => value.startsWith("__Secure-openinspect.state="))).toBe(
      true
    );
    expect(
      callbackCookies.some((value) => value.startsWith("__Secure-openinspect.session_token="))
    ).toBe(true);
    expect(callbackCookies.length).toBeGreaterThanOrEqual(2);
    expectCommonResponseHeaders(callback, traceId);
  });

  it("preserves a streamed 206 response and its byte-range headers", async () => {
    const { artifactId, sessionName } = await uploadVideoFixture();
    const traceId = "range-stream-trace";
    const response = await serviceFetch(
      `https://test.local/sessions/${sessionName}/media/${artifactId}`,
      {
        service: "slack-bot",
        headers: { Range: "bytes=4-11", "x-trace-id": traceId },
      }
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Type")).toBe("video/mp4");
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    expect(response.headers.get("Content-Range")).toBe(`bytes 4-11/${MP4_BYTES.byteLength}`);
    expect(response.headers.get("Content-Length")).toBe("8");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(MP4_BYTES.slice(4, 12));
    expectCommonResponseHeaders(response, traceId);
  });

  it("maps an unknown handler exception to the generic decorated 500 response", async () => {
    const { artifactId, sessionName } = await uploadVideoFixture();
    const traceId = "unknown-handler-error-trace";
    const url = `https://test.local/sessions/${sessionName}/media/${artifactId}`;
    const request = await signedRequest({
      url,
      service: "slack-bot",
      headers: { Range: "bytes=0-3", "x-trace-id": traceId },
    });
    const unavailableBucket = {
      head: async () => ({
        size: MP4_BYTES.byteLength,
        httpEtag: '"response-compat"',
        writeHttpMetadata: () => {
          throw new Error("R2 response compatibility failure");
        },
      }),
      get: async () => ({
        body: new Blob([MP4_BYTES.slice(0, 4)]).stream(),
      }),
    } as unknown as R2Bucket;

    const response = await fetchWorker(request, { ...env, MEDIA_BUCKET: unavailableBucket } as Env);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Internal server error" });
    expectCommonResponseHeaders(response, traceId);
  });
});
