import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchUser,
  getClientCredentialsTokenOrThrow,
  getLinearClientOrThrow,
  updateAgentSession,
} from "./linear-client";
import {
  createFakeKV,
  createLinearFetchMock,
  linearClientCredentialsResponse,
  linearIdentityResponse,
  makeLinearBotEnv,
} from "../test-helpers";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function successfulIssuanceFetch(
  accessToken = "runtime-access-token",
  organizationId = "org-1",
  appUserId = "app-user-1"
) {
  return createLinearFetchMock({
    clientCredentials: () => linearClientCredentialsResponse(accessToken),
    identity: () => linearIdentityResponse(organizationId, appUserId),
  });
}

function cachedToken(accessToken = "cached-token") {
  const issuedAt = Date.now();
  return JSON.stringify({
    version: 1,
    access_token: accessToken,
    token_type: "Bearer",
    scope: "read,write,app:assignable,app:mentionable",
    issued_at: issuedAt,
    expires_at: issuedAt + 60 * 60 * 1000,
    organization_id: "org-1",
    organization_name: "Acme",
    app_user_id: "app-user-1",
  });
}

describe("Linear client credentials", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("mints and caches a verified runtime token when the cache is empty", async () => {
    const { kv, store, putCalls } = createFakeKV();
    const env = makeLinearBotEnv(kv);
    const fetchMock = createLinearFetchMock({
      clientCredentials: () =>
        linearClientCredentialsResponse("runtime-access-token", {
          token_type: "bearer",
          scope: "app:mentionable read app:assignable write",
        }),
      identity: () => linearIdentityResponse(),
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = await getLinearClientOrThrow(env, "org-1", "app-user-1");

    expect(client.accessToken).toBe("runtime-access-token");
    const tokenRequest = fetchMock.mock.calls[0];
    expect(tokenRequest?.[0]).toBe("https://api.linear.app/oauth/token");
    const requestBody = tokenRequest?.[1]?.body as URLSearchParams;
    expect(Object.fromEntries(requestBody.entries())).toEqual({
      grant_type: "client_credentials",
      client_id: "linear-client-id",
      client_secret: "linear-client-secret",
      scope: "read,write,app:assignable,app:mentionable",
    });
    expect(JSON.parse(store.get("oauth:client-credentials:org-1") ?? "{}")).toMatchObject({
      version: 1,
      access_token: "runtime-access-token",
      token_type: "Bearer",
      scope: "read,write,app:assignable,app:mentionable",
      organization_id: "org-1",
      organization_name: "Acme",
      app_user_id: "app-user-1",
    });
    expect(putCalls[0]?.options?.expirationTtl).toBe(2_592_000);
    expect(store.get("oauth:client-credentials:org-1")).not.toContain("refresh_token");
  });

  it("treats a malformed cache entry as a miss", async () => {
    const { kv } = createFakeKV({
      "oauth:client-credentials:org-1": "{not-json",
    });
    const env = makeLinearBotEnv(kv);
    vi.stubGlobal("fetch", successfulIssuanceFetch("replacement-token"));

    const client = await getLinearClientOrThrow(env, "org-1", "app-user-1");

    expect(client.accessToken).toBe("replacement-token");
  });

  it("mints a token when the cache cannot be read", async () => {
    const { kv } = createFakeKV();
    const env = makeLinearBotEnv(kv);
    vi.mocked(kv.get).mockRejectedValueOnce(new Error("KV unavailable"));
    vi.stubGlobal("fetch", successfulIssuanceFetch());

    const client = await getLinearClientOrThrow(env, "org-1", "app-user-1");

    expect(client.accessToken).toBe("runtime-access-token");
  });

  it("returns a verified token when the cache cannot be written", async () => {
    const { kv } = createFakeKV({ "oauth:token:org-1": "legacy-sensitive-value" });
    const env = makeLinearBotEnv(kv);
    vi.mocked(kv.put).mockRejectedValueOnce(new Error("KV unavailable"));
    vi.stubGlobal("fetch", successfulIssuanceFetch());

    const client = await getLinearClientOrThrow(env, "org-1", "app-user-1");

    expect(client.accessToken).toBe("runtime-access-token");
    expect(kv.delete).not.toHaveBeenCalled();
  });

  it("deletes the legacy refresh-token record after caching succeeds", async () => {
    const { kv, store } = createFakeKV({
      "oauth:token:org-1": JSON.stringify({ refresh_token: "legacy-refresh-token" }),
    });
    const env = makeLinearBotEnv(kv);
    vi.stubGlobal("fetch", successfulIssuanceFetch());

    await getLinearClientOrThrow(env, "org-1", "app-user-1");

    expect(kv.delete).toHaveBeenCalledWith("oauth:token:org-1");
    expect(store.has("oauth:token:org-1")).toBe(false);
  });

  it("rejects malformed client-credentials token responses", async () => {
    const { kv } = createFakeKV();
    const env = makeLinearBotEnv(kv);
    vi.stubGlobal(
      "fetch",
      createLinearFetchMock({
        clientCredentials: () => linearClientCredentialsResponse(""),
      })
    );

    await expect(getLinearClientOrThrow(env, "org-1", "app-user-1")).rejects.toMatchObject({
      name: "LinearAuthError",
      reason: "client_credentials_malformed_response",
    });
  });

  it("renews and replays one GraphQL request after an HTTP 401", async () => {
    const { kv } = createFakeKV({
      "oauth:client-credentials:org-1": cachedToken("expired-at-provider-token"),
    });
    const env = makeLinearBotEnv(kv);
    const fetchMock = createLinearFetchMock({
      clientCredentials: () => linearClientCredentialsResponse("renewed-token"),
      identity: () => linearIdentityResponse(),
      graphql: ({ accessToken }) =>
        accessToken === "expired-at-provider-token"
          ? new Response(null, { status: 401 })
          : Response.json({
              data: {
                user: { id: "user-1", name: "Alice", email: "alice@example.test" },
              },
            }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = await getLinearClientOrThrow(env, "org-1", "app-user-1");

    const user = await fetchUser(client, "user-1");

    expect(user).toEqual({ id: "user-1", name: "Alice", email: "alice@example.test" });
    expect(client.accessToken).toBe("renewed-token");
    const graphQlRequests = fetchMock.mock.calls.filter(([, init]) =>
      String(init?.body).includes("FetchUser")
    );
    const firstGraphQlRequest = graphQlRequests[0]?.[1];
    const replayedGraphQlRequest = graphQlRequests[1]?.[1];
    expect(firstGraphQlRequest?.body).toBe(replayedGraphQlRequest?.body);
    expect(new Headers(firstGraphQlRequest?.headers).get("Authorization")).toBe(
      "Bearer expired-at-provider-token"
    );
    expect(new Headers(replayedGraphQlRequest?.headers).get("Authorization")).toBe(
      "Bearer renewed-token"
    );
  });

  it("uses a valid verified cache entry without an HTTP request", async () => {
    const { kv } = createFakeKV({
      "oauth:client-credentials:org-1": cachedToken(),
    });
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const client = await getLinearClientOrThrow(makeLinearBotEnv(kv), "org-1", "app-user-1");

    expect(client.accessToken).toBe("cached-token");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("force renewal bypasses a valid cache entry", async () => {
    const { kv } = createFakeKV({
      "oauth:client-credentials:org-1": cachedToken(),
    });
    const fetchMock = successfulIssuanceFetch("forced-token");
    vi.stubGlobal("fetch", fetchMock);

    const token = await getClientCredentialsTokenOrThrow(makeLinearBotEnv(kv), "org-1", {
      forceRenew: true,
      expectedAppUserId: "app-user-1",
    });

    expect(token).toBe("forced-token");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects a token for a different Linear organization without caching it", async () => {
    const { kv, store } = createFakeKV();
    vi.stubGlobal("fetch", successfulIssuanceFetch("wrong-workspace-token", "org-2"));

    await expect(
      getLinearClientOrThrow(makeLinearBotEnv(kv), "org-1", "app-user-1")
    ).rejects.toMatchObject({ reason: "client_credentials_workspace_mismatch" });
    expect(store.has("oauth:client-credentials:org-1")).toBe(false);
  });

  it("rejects a token for a different installed app user without caching it", async () => {
    const { kv, store } = createFakeKV();
    vi.stubGlobal(
      "fetch",
      successfulIssuanceFetch("wrong-app-token", "org-1", "different-app-user")
    );

    await expect(
      getLinearClientOrThrow(makeLinearBotEnv(kv), "org-1", "app-user-1")
    ).rejects.toMatchObject({ reason: "client_credentials_app_user_mismatch" });
    expect(store.has("oauth:client-credentials:org-1")).toBe(false);
  });

  it("rejects a granted scope that differs from the canonical scope", async () => {
    const { kv } = createFakeKV();
    vi.stubGlobal(
      "fetch",
      createLinearFetchMock({
        clientCredentials: () =>
          linearClientCredentialsResponse("wrong-scope-token", { scope: "read write" }),
      })
    );

    await expect(
      getLinearClientOrThrow(makeLinearBotEnv(kv), "org-1", "app-user-1")
    ).rejects.toMatchObject({ reason: "client_credentials_invalid_scope" });
  });

  it.each([
    [400, "invalid_client", "client_credentials_invalid_client"],
    [400, "invalid_scope", "client_credentials_invalid_scope"],
    [429, "rate_limited", "client_credentials_rate_limited"],
    [503, "temporarily_unavailable", "client_credentials_rejected"],
  ])("classifies token endpoint status %s with %s", async (status, oauthError, reason) => {
    const { kv } = createFakeKV();
    vi.stubGlobal(
      "fetch",
      createLinearFetchMock({
        clientCredentials: () =>
          jsonResponse({ error: oauthError, error_description: "must-not-be-logged" }, status),
      })
    );

    await expect(
      getLinearClientOrThrow(makeLinearBotEnv(kv), "org-1", "app-user-1")
    ).rejects.toMatchObject({ reason, status, oauthError });
  });

  it("does not log provider descriptions that may reflect credentials", async () => {
    const reflectedSecret = "reflected-client-secret";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { kv } = createFakeKV();
    vi.stubGlobal(
      "fetch",
      createLinearFetchMock({
        clientCredentials: () =>
          jsonResponse(
            {
              error: "invalid_client",
              error_description: `Rejected ${reflectedSecret}`,
            },
            400
          ),
      })
    );

    await expect(
      getLinearClientOrThrow(makeLinearBotEnv(kv), "org-1", "app-user-1")
    ).rejects.toMatchObject({ reason: "client_credentials_invalid_client" });

    expect(errorSpy.mock.calls.map(([entry]) => String(entry)).join("\n")).not.toContain(
      reflectedSecret
    );
  });

  it("does not attempt a second renewal after the replay is also unauthorized", async () => {
    const { kv } = createFakeKV({
      "oauth:client-credentials:org-1": cachedToken("rejected-token"),
    });
    const fetchMock = createLinearFetchMock({
      clientCredentials: () => linearClientCredentialsResponse("replacement-token"),
      identity: () => linearIdentityResponse(),
      graphql: () => new Response(null, { status: 401 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = await getLinearClientOrThrow(makeLinearBotEnv(kv), "org-1", "app-user-1");

    await expect(fetchUser(client, "user-1")).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("does not renew or replay a non-401 GraphQL failure", async () => {
    const { kv } = createFakeKV({
      "oauth:client-credentials:org-1": cachedToken(),
    });
    const fetchMock = createLinearFetchMock({
      graphql: () => new Response(null, { status: 403 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = await getLinearClientOrThrow(makeLinearBotEnv(kv), "org-1", "app-user-1");

    await expect(fetchUser(client, "user-1")).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("replays an identical mutation body only once after an HTTP 401", async () => {
    const { kv } = createFakeKV({
      "oauth:client-credentials:org-1": cachedToken("mutation-token"),
    });
    const fetchMock = createLinearFetchMock({
      clientCredentials: () => linearClientCredentialsResponse("renewed-mutation-token"),
      identity: () => linearIdentityResponse(),
      graphql: ({ accessToken }) =>
        accessToken === "mutation-token"
          ? new Response(null, { status: 401 })
          : Response.json({ data: { agentSessionUpdate: { success: true } } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = await getLinearClientOrThrow(makeLinearBotEnv(kv), "org-1", "app-user-1");

    await updateAgentSession(client, "agent-session-1", { externalUrls: [] });

    const mutationRequests = fetchMock.mock.calls.filter(([, init]) =>
      String(init?.body).includes("AgentSessionUpdate")
    );
    expect(mutationRequests[0]?.[1]?.body).toBe(mutationRequests[1]?.[1]?.body);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("classifies token endpoint network failures", async () => {
    const { kv } = createFakeKV();
    vi.stubGlobal(
      "fetch",
      createLinearFetchMock({
        clientCredentials: () => {
          throw new Error("offline");
        },
      })
    );

    await expect(
      getLinearClientOrThrow(makeLinearBotEnv(kv), "org-1", "app-user-1")
    ).rejects.toMatchObject({ reason: "client_credentials_error" });
  });

  it("rejects an invalid viewer identity response", async () => {
    const { kv } = createFakeKV();
    vi.stubGlobal(
      "fetch",
      createLinearFetchMock({
        clientCredentials: () => linearClientCredentialsResponse("unverified-token"),
        identity: () => jsonResponse({ data: { viewer: null } }),
      })
    );

    await expect(
      getLinearClientOrThrow(makeLinearBotEnv(kv), "org-1", "app-user-1")
    ).rejects.toMatchObject({ reason: "client_credentials_identity_error" });
  });

  it.each([
    [{ access_token: "token", token_type: "Basic", expires_in: 2_592_000 }],
    [{ access_token: "token", token_type: "Bearer", expires_in: 60 }],
    [{ access_token: "token", token_type: "Bearer", expires_in: Number.POSITIVE_INFINITY }],
  ])("rejects an unsafe token lease %#", async (tokenResponse) => {
    const { kv } = createFakeKV();
    vi.stubGlobal(
      "fetch",
      createLinearFetchMock({
        clientCredentials: () => jsonResponse(tokenResponse),
      })
    );

    await expect(
      getLinearClientOrThrow(makeLinearBotEnv(kv), "org-1", "app-user-1")
    ).rejects.toMatchObject({ reason: "client_credentials_malformed_response" });
  });
});
