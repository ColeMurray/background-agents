/**
 * Unit tests for DaytonaRestClient.
 *
 * Tests URL construction, auth headers, request body building, error
 * classification, and timeout handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  DaytonaRestClient,
  DaytonaNotFoundError,
  DaytonaApiError,
  DAYTONA_SANDBOX_STATES,
  DAYTONA_SNAPSHOT_STATES,
  daytonaBuildResourceName,
  daytonaSandboxResponseSchema,
  daytonaSignedPreviewUrlResponseSchema,
  parseDaytonaSandboxState,
  parseDaytonaSnapshotState,
  type DaytonaRestConfig,
} from "./daytona-rest-client";

// ==================== Helpers ====================

const defaultConfig: DaytonaRestConfig = {
  apiUrl: "https://daytona.test/api",
  apiKey: "test-api-key",
  baseSnapshot: "base-snapshot-v1",
  autoStopIntervalMinutes: 120,
  autoArchiveIntervalMinutes: 10080,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function emptyResponse(status = 200): Response {
  return new Response(null, { status });
}

/** Asserts the call failed with a Daytona API error and hands it back typed. */
async function rejectedApiError(promise: Promise<unknown>): Promise<DaytonaApiError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DaytonaApiError);
    return error as DaytonaApiError;
  }
  return expect.unreachable("expected a DaytonaApiError");
}

/**
 * Wire shapes of the generated Daytona toolbox request models, read from
 * `daytona-toolbox-api-client` 0.211.2: each entry is a model's `__properties`
 * list and the subset that model marks required. A toolbox body is asserted
 * against the model its endpoint declares, so an SDK bump that renames a field
 * has one place to re-check rather than an ad-hoc shape per test.
 */
const TOOLBOX_REQUEST_MODELS = {
  // POST /process/session
  CreateSessionRequest: { properties: ["sessionId"], required: ["sessionId"] },
  // POST /process/session/{sessionId}/exec. "async" is the deprecated alias of
  // "runAsync" and is not sent.
  SessionExecuteRequest: {
    properties: ["async", "command", "runAsync", "suppressInputEcho"],
    required: ["command"],
  },
  // POST /process/session/{sessionId}/command/{commandId}/input
  SessionSendInputRequest: { properties: ["data"], required: ["data"] },
} as const;

let fetchSpy: ReturnType<typeof vi.fn>;

/** The body of the most recent request, as the transport serialized it. */
function lastRequestBody(): Record<string, unknown> {
  const calls = fetchSpy.mock.calls;
  const [, init] = calls[calls.length - 1];
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

/**
 * Assert the last request body satisfies the generated model it is sent as:
 * no field that model does not declare, and every field it requires.
 */
function expectLastBodyMatchesModel(model: keyof typeof TOOLBOX_REQUEST_MODELS): void {
  const { properties, required } = TOOLBOX_REQUEST_MODELS[model];
  const body = lastRequestBody();
  const fields = Object.keys(body);
  expect(fields.filter((field) => !(properties as readonly string[]).includes(field))).toEqual([]);
  expect(fields).toEqual(expect.arrayContaining([...required]));
}

beforeEach(() => {
  fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ==================== Tests ====================

describe("DaytonaRestClient", () => {
  describe("constructor validation", () => {
    it("throws when apiUrl is missing", () => {
      expect(() => new DaytonaRestClient({ ...defaultConfig, apiUrl: "" })).toThrow(
        "requires apiUrl"
      );
    });

    it("throws when apiKey is missing", () => {
      expect(() => new DaytonaRestClient({ ...defaultConfig, apiKey: "" })).toThrow(
        "requires apiKey"
      );
    });

    // A deployment that has switched providers still finalizes and reclaims
    // the Daytona resources its last configuration created, so credentials
    // without a current base image must construct.
    it("constructs without a base snapshot and refuses only creates", () => {
      const client = new DaytonaRestClient({ ...defaultConfig, baseSnapshot: "" });

      expect(() => client.requireBaseSnapshot()).toThrow("DAYTONA_BASE_SNAPSHOT is required");
      expect(new DaytonaRestClient(defaultConfig).requireBaseSnapshot()).toBe("base-snapshot-v1");
    });

    it("strips trailing slashes from apiUrl", async () => {
      const client = new DaytonaRestClient({ ...defaultConfig, apiUrl: "https://api.test///" });
      fetchSpy.mockResolvedValue(jsonResponse({ id: "sb-1", state: "started" }));
      await client.getSandbox("sb-1");
      expect(fetchSpy).toHaveBeenCalledWith("https://api.test/sandbox/sb-1", expect.anything());
    });
  });

  describe("auth headers", () => {
    it("sends Bearer token in Authorization header", async () => {
      const client = new DaytonaRestClient(defaultConfig);
      fetchSpy.mockResolvedValue(jsonResponse({ id: "sb-1", state: "started" }));

      await client.getSandbox("sb-1");

      const [, init] = fetchSpy.mock.calls[0];
      expect(init.headers).toEqual(
        expect.objectContaining({
          Authorization: "Bearer test-api-key",
          "Content-Type": "application/json",
        })
      );
    });
  });

  describe("createSandbox", () => {
    it("sends POST /sandbox with correct body", async () => {
      const client = new DaytonaRestClient(defaultConfig);
      fetchSpy.mockResolvedValue(jsonResponse({ id: "daytona-id", state: "started" }));

      const params = {
        name: "sandbox-123",
        snapshot: "base-snapshot-v1",
        env: { FOO: "bar" },
        labels: { key: "value" },
        autoStopInterval: 120,
        autoArchiveInterval: 10080,
        public: false,
      };

      const result = await client.createSandbox(params);

      expect(fetchSpy).toHaveBeenCalledWith(
        "https://daytona.test/api/sandbox",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify(params),
        })
      );
      expect(result).toEqual({ id: "daytona-id", state: "started" });
    });
  });

  describe("getSandbox", () => {
    it("sends GET /sandbox/{id}", async () => {
      const client = new DaytonaRestClient(defaultConfig);
      fetchSpy.mockResolvedValue(jsonResponse({ id: "sb-1", state: "stopped", recoverable: true }));

      const result = await client.getSandbox("sb-1");

      expect(fetchSpy).toHaveBeenCalledWith(
        "https://daytona.test/api/sandbox/sb-1",
        expect.objectContaining({ method: "GET" })
      );
      expect(result).toEqual({ id: "sb-1", state: "stopped", recoverable: true });
    });

    it("rejects malformed sandbox response bodies", async () => {
      const client = new DaytonaRestClient(defaultConfig);
      fetchSpy.mockResolvedValue(jsonResponse({ id: "sb-1" }));

      await expect(client.getSandbox("sb-1")).rejects.toMatchObject({
        name: "DaytonaApiError",
        message: "Invalid Daytona API response",
      });
    });
  });

  describe("startSandbox", () => {
    it("sends POST /sandbox/{id}/start", async () => {
      const client = new DaytonaRestClient(defaultConfig);
      fetchSpy.mockResolvedValue(emptyResponse(200));

      await client.startSandbox("sb-1");

      expect(fetchSpy).toHaveBeenCalledWith(
        "https://daytona.test/api/sandbox/sb-1/start",
        expect.objectContaining({ method: "POST" })
      );
    });
  });

  describe("stopSandbox", () => {
    it("sends POST /sandbox/{id}/stop", async () => {
      const client = new DaytonaRestClient(defaultConfig);
      fetchSpy.mockResolvedValue(emptyResponse(200));

      await client.stopSandbox("sb-1");

      expect(fetchSpy).toHaveBeenCalledWith(
        "https://daytona.test/api/sandbox/sb-1/stop",
        expect.objectContaining({ method: "POST" })
      );
    });
  });

  describe("deleteSandbox", () => {
    it("sends DELETE /sandbox/{id}", async () => {
      const client = new DaytonaRestClient(defaultConfig);
      fetchSpy.mockResolvedValue(emptyResponse(204));

      await client.deleteSandbox("sb-1");

      expect(fetchSpy).toHaveBeenCalledWith(
        "https://daytona.test/api/sandbox/sb-1",
        expect.objectContaining({ method: "DELETE" })
      );
    });

    it("combines a caller abort signal with the request timeout", async () => {
      const client = new DaytonaRestClient(defaultConfig);
      const controller = new AbortController();
      controller.abort();
      fetchSpy.mockResolvedValue(emptyResponse(204));

      await client.deleteSandbox("sb-1", controller.signal);

      expect(fetchSpy.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
      expect(fetchSpy.mock.calls[0][1].signal.aborted).toBe(true);
    });
  });

  describe("recoverSandbox", () => {
    it("sends POST /sandbox/{id}/recover", async () => {
      const client = new DaytonaRestClient(defaultConfig);
      fetchSpy.mockResolvedValue(emptyResponse(200));

      await client.recoverSandbox("sb-1");

      expect(fetchSpy).toHaveBeenCalledWith(
        "https://daytona.test/api/sandbox/sb-1/recover",
        expect.objectContaining({ method: "POST" })
      );
    });
  });

  describe("getSignedPreviewUrl", () => {
    // The API reads the expiry from `expiresInSeconds`; sent under any other
    // name it is dropped and the URL is signed with the API's own default.
    it("sends GET with port and expiry query param", async () => {
      const client = new DaytonaRestClient(defaultConfig);
      fetchSpy.mockResolvedValue(jsonResponse({ url: "https://preview.test/abc" }));

      const result = await client.getSignedPreviewUrl("sb-1", 8080, 3900);

      expect(fetchSpy).toHaveBeenCalledWith(
        "https://daytona.test/api/sandbox/sb-1/ports/8080/signed-preview-url?expiresInSeconds=3900",
        expect.objectContaining({ method: "GET" })
      );
      expect(result.url).toBe("https://preview.test/abc");
    });

    it("rejects malformed signed preview URL response bodies", async () => {
      const client = new DaytonaRestClient(defaultConfig);
      fetchSpy.mockResolvedValue(jsonResponse({ url: null }));

      await expect(client.getSignedPreviewUrl("sb-1", 8080, 3900)).rejects.toMatchObject({
        name: "DaytonaApiError",
        message: "Invalid Daytona API response",
      });
    });
  });

  // Endpoints that return a value must produce one or fail. A success that
  // carries no parsable body used to fall through as `undefined`, handing
  // callers a value that violated the declared return type.
  describe("required response bodies", () => {
    it("rejects a success with no body", async () => {
      const client = new DaytonaRestClient(defaultConfig);
      fetchSpy.mockResolvedValue(emptyResponse(200));

      await expect(client.getSandbox("sb-1")).rejects.toMatchObject({
        name: "DaytonaApiError",
        message: "Invalid Daytona API response",
      });
    });

    it("rejects a non-JSON success body", async () => {
      const client = new DaytonaRestClient(defaultConfig);
      fetchSpy.mockResolvedValue(new Response("OK", { status: 200 }));

      await expect(client.createSandbox({ name: "test", snapshot: "snap" })).rejects.toMatchObject({
        name: "DaytonaApiError",
      });
    });

    it("reports invalid JSON as an API error rather than a parser error", async () => {
      const client = new DaytonaRestClient(defaultConfig);
      fetchSpy.mockResolvedValue(
        new Response('{"url": ', { status: 200, headers: { "content-type": "application/json" } })
      );

      await expect(client.getSignedPreviewUrl("sb-1", 8080, 3900)).rejects.toMatchObject({
        name: "DaytonaApiError",
        message: "Invalid Daytona API response",
      });
    });

    it("parses a JSON body that arrives without a JSON content type", async () => {
      const client = new DaytonaRestClient(defaultConfig);
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ id: "sb-1", state: "started" }), { status: 200 })
      );

      await expect(client.getSandbox("sb-1")).resolves.toEqual({ id: "sb-1", state: "started" });
    });

    it("commands ignore whatever a success body contains", async () => {
      const client = new DaytonaRestClient(defaultConfig);
      fetchSpy.mockResolvedValue(jsonResponse({ unexpected: "payload" }));

      await expect(client.startSandbox("sb-1")).resolves.toBeUndefined();
      await expect(client.recoverSandbox("sb-1")).resolves.toBeUndefined();
    });
  });

  describe("response schemas", () => {
    it("parses a valid sandbox response with an optional recoverable flag", () => {
      expect(
        daytonaSandboxResponseSchema.safeParse({
          id: "sb-1",
          state: "started",
          recoverable: false,
        }).success
      ).toBe(true);
    });

    it("rejects a partial sandbox response", () => {
      expect(daytonaSandboxResponseSchema.safeParse({ id: "sb-1" }).success).toBe(false);
    });

    it("parses a valid signed preview URL response", () => {
      expect(
        daytonaSignedPreviewUrlResponseSchema.safeParse({ url: "https://preview.test/abc" }).success
      ).toBe(true);
    });
  });

  describe("error classification", () => {
    it("throws DaytonaNotFoundError on 404", async () => {
      const client = new DaytonaRestClient(defaultConfig);
      fetchSpy.mockResolvedValue(new Response("not found", { status: 404 }));

      await expect(client.getSandbox("missing")).rejects.toThrow(DaytonaNotFoundError);
    });

    it("throws DaytonaApiError on 500", async () => {
      const client = new DaytonaRestClient(defaultConfig);
      fetchSpy.mockResolvedValue(new Response("server error", { status: 500 }));

      try {
        await client.getSandbox("sb-1");
        expect.unreachable("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(DaytonaApiError);
        expect((e as DaytonaApiError).status).toBe(500);
      }
    });

    it("throws DaytonaApiError on 502 (transient)", async () => {
      const client = new DaytonaRestClient(defaultConfig);
      fetchSpy.mockResolvedValue(new Response("bad gateway", { status: 502 }));

      try {
        await client.getSandbox("sb-1");
        expect.unreachable("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(DaytonaApiError);
        expect((e as DaytonaApiError).status).toBe(502);
      }
    });

    it("throws DaytonaApiError on 401", async () => {
      const client = new DaytonaRestClient(defaultConfig);
      fetchSpy.mockResolvedValue(new Response("unauthorized", { status: 401 }));

      try {
        await client.createSandbox({
          name: "test",
          snapshot: "snap",
        });
        expect.unreachable("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(DaytonaApiError);
        expect((e as DaytonaApiError).status).toBe(401);
      }
    });
  });

  describe("timeout handling", () => {
    it("aborts request when timeout expires", async () => {
      const client = new DaytonaRestClient(defaultConfig);

      fetchSpy.mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => {
              reject(new DOMException("The operation was aborted.", "AbortError"));
            });
          })
      );

      // getSandbox has a 15s timeout — we can't actually wait 15s in tests,
      // but we verify the signal is passed to fetch
      const promise = client.getSandbox("sb-1");
      const [, init] = fetchSpy.mock.calls[0];
      expect(init.signal).toBeInstanceOf(AbortSignal);

      // Manually abort to verify error propagation
      init.signal.dispatchEvent(new Event("abort"));
      await expect(promise).rejects.toThrow();
    });
  });
});

describe("DaytonaRestClient snapshots", () => {
  const client = () => new DaytonaRestClient(defaultConfig);

  it("requests a filesystem-only capture and returns the SOURCE sandbox", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ id: "sb-1", state: "snapshotting" }));

    const result = await client().createSandboxSnapshot("sb-1", {
      name: "oi-image-abc",
      includeMemory: false,
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://daytona.test/api/sandbox/sb-1/snapshot",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "oi-image-abc", includeMemory: false }),
      })
    );
    expect(result.id).toBe("sb-1");
  });

  it("looks a snapshot up by name and reports the sandbox it came from", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({
        id: "snap-1",
        name: "oi-image-abc",
        state: "active",
        sourceSandboxId: "sb-1",
      })
    );

    const snapshot = await client().getSnapshot("oi-image-abc");

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://daytona.test/api/snapshots/oi-image-abc",
      expect.objectContaining({ method: "GET" })
    );
    expect(snapshot).toMatchObject({ id: "snap-1", state: "active", sourceSandboxId: "sb-1" });
  });

  it("reports an absent snapshot as not found rather than an API error", async () => {
    fetchSpy.mockResolvedValue(new Response("no such snapshot", { status: 404 }));

    await expect(client().getSnapshot("oi-image-abc")).rejects.toBeInstanceOf(DaytonaNotFoundError);
  });

  it("keeps a lenient optional field from failing the whole snapshot read", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({ id: "snap-1", name: "oi-image-abc", state: "error", errorReason: 42 })
    );

    await expect(client().getSnapshot("oi-image-abc")).resolves.toMatchObject({
      id: "snap-1",
      state: "error",
    });
  });

  it("activates and deletes a snapshot by its immutable id", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({ id: "snap-1", name: "oi-image-abc", state: "active" })
    );
    await client().activateSnapshot("snap-1");
    expect(fetchSpy).toHaveBeenLastCalledWith(
      "https://daytona.test/api/snapshots/snap-1/activate",
      expect.objectContaining({ method: "POST" })
    );

    fetchSpy.mockResolvedValue(emptyResponse(204));
    await client().deleteSnapshot("snap-1");
    expect(fetchSpy).toHaveBeenLastCalledWith(
      "https://daytona.test/api/snapshots/snap-1",
      expect.objectContaining({ method: "DELETE" })
    );
  });

  it("carries a caller signal through capture and snapshot reads", async () => {
    const controller = new AbortController();
    controller.abort();
    fetchSpy.mockResolvedValue(jsonResponse({ id: "sb-1", state: "snapshotting" }));

    await client().createSandboxSnapshot(
      "sb-1",
      { name: "oi-image-abc", includeMemory: false },
      controller.signal
    );

    expect(fetchSpy.mock.calls[0][1].signal.aborted).toBe(true);
  });
});

describe("DaytonaRestClient toolbox transport", () => {
  const target = { sandboxId: "sb-1", baseUrl: "https://runner.test/toolbox" };

  it("prefers the configured toolbox override over any per-sandbox value", async () => {
    const client = new DaytonaRestClient({
      ...defaultConfig,
      toolboxApiUrl: "https://toolbox.internal/",
    });

    await expect(
      client.resolveToolboxBaseUrl("sb-1", {
        sandbox: { id: "sb-1", state: "started", toolboxProxyUrl: "https://ignored.test" },
      })
    ).resolves.toBe("https://toolbox.internal");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("uses the proxy URL the sandbox already reported", async () => {
    await expect(
      new DaytonaRestClient(defaultConfig).resolveToolboxBaseUrl("sb-1", {
        sandbox: { id: "sb-1", state: "started", toolboxProxyUrl: "https://runner.test/toolbox/" },
      })
    ).resolves.toBe("https://runner.test/toolbox");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("falls back to the dedicated lookup, never to a hard-coded host", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ url: "https://runner-7.test/toolbox" }));

    await expect(new DaytonaRestClient(defaultConfig).resolveToolboxBaseUrl("sb-1")).resolves.toBe(
      "https://runner-7.test/toolbox"
    );
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://daytona.test/api/sandbox/sb-1/toolbox-proxy-url",
      expect.objectContaining({ method: "GET" })
    );
  });

  // Every toolbox request carries the API key in its Authorization header, so
  // a base URL that would carry it in cleartext must be refused before any
  // request reaches that host.
  it("refuses a plaintext configured toolbox URL before any request", async () => {
    const client = new DaytonaRestClient({
      ...defaultConfig,
      toolboxApiUrl: "http://toolbox.internal",
    });

    await expect(client.resolveToolboxBaseUrl("sb-1")).rejects.toThrow(
      /configured toolbox URL must use https, not http/
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a plaintext proxy URL the sandbox reported", async () => {
    await expect(
      new DaytonaRestClient(defaultConfig).resolveToolboxBaseUrl("sb-1", {
        sandbox: { id: "sb-1", state: "started", toolboxProxyUrl: "http://runner.test/toolbox" },
      })
    ).rejects.toThrow(/sandbox-reported toolbox proxy URL must use https, not http/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a plaintext proxy URL the lookup returned, without addressing it", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ url: "http://runner-7.test/toolbox" }));

    await expect(
      new DaytonaRestClient(defaultConfig).resolveToolboxBaseUrl("sb-1")
    ).rejects.toThrow(/toolbox proxy lookup must use https, not http/);

    // Only the lookup itself, against the configured API: nothing was sent to
    // the host it named.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://daytona.test/api/sandbox/sb-1/toolbox-proxy-url",
      expect.objectContaining({ method: "GET" })
    );
  });

  it.each(["ftp://toolbox.internal", "toolbox.internal", "https://"])(
    "refuses a toolbox URL it cannot use (%s)",
    async (toolboxApiUrl) => {
      const client = new DaytonaRestClient({ ...defaultConfig, toolboxApiUrl });

      await expect(client.resolveToolboxBaseUrl("sb-1")).rejects.toThrow(
        /configured toolbox URL (must use https|is not a valid URL)/
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    }
  );

  it.each(["localhost:3986", "127.0.0.1:3986", "[::1]:3986"])(
    "keeps a loopback runner reachable over plain http (%s)",
    async (host) => {
      const client = new DaytonaRestClient({
        ...defaultConfig,
        toolboxApiUrl: `http://${host}/`,
      });

      await expect(client.resolveToolboxBaseUrl("sb-1")).resolves.toBe(`http://${host}`);
      expect(fetchSpy).not.toHaveBeenCalled();
    }
  );

  // A refusal reaches structured logs, and a proxy URL can itself carry a
  // signed token: the message names the source and the scheme only.
  it("never puts the rejected URL or the API key in the refusal", async () => {
    const client = new DaytonaRestClient({
      ...defaultConfig,
      toolboxApiUrl: "http://toolbox.internal/tok-abcdef",
    });

    const error = await client.resolveToolboxBaseUrl("sb-1").catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("tok-abcdef");
    expect((error as Error).message).not.toContain("toolbox.internal");
    expect((error as Error).message).not.toContain(defaultConfig.apiKey);
  });

  it("prefixes every toolbox route with the sandbox it addresses", async () => {
    const client = new DaytonaRestClient(defaultConfig);
    fetchSpy.mockResolvedValue(emptyResponse(200));

    await client.createProcessSession(target, "oi-build");

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://runner.test/toolbox/sb-1/process/session",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ sessionId: "oi-build" }) })
    );
    expectLastBodyMatchesModel("CreateSessionRequest");
  });

  it("starts a command asynchronously with input echo suppressed", async () => {
    const client = new DaytonaRestClient(defaultConfig);
    fetchSpy.mockResolvedValue(jsonResponse({ cmdId: "cmd-1" }));

    const started = await client.executeSessionCommand(target, "oi-build", "python -m runtime");

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://runner.test/toolbox/sb-1/process/session/oi-build/exec",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          command: "python -m runtime",
          runAsync: true,
          suppressInputEcho: true,
        }),
      })
    );
    expectLastBodyMatchesModel("SessionExecuteRequest");
    expect(started.cmdId).toBe("cmd-1");
  });

  // The toolbox delivers stdin from `data`: under any other field name the
  // payload never reaches the command, and a build launches with no context.
  it("writes stdin under the field the toolbox delivers", async () => {
    const client = new DaytonaRestClient(defaultConfig);
    fetchSpy.mockResolvedValue(emptyResponse(200));

    await client.sendSessionCommandInput(target, "oi-build", "cmd-1", '{"version":1}\n');

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://runner.test/toolbox/sb-1/process/session/oi-build/command/cmd-1/input",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ data: '{"version":1}\n' }),
      })
    );
    expectLastBodyMatchesModel("SessionSendInputRequest");
  });

  // Fields read from the generated response models of the same client 0.211.2:
  // `Command` carries `id` and `exitCode`, `SessionExecuteResponse` `cmdId`.
  it("reads a command's exit status and deletes its session", async () => {
    const client = new DaytonaRestClient(defaultConfig);
    fetchSpy.mockResolvedValue(jsonResponse({ id: "cmd-1", exitCode: 1 }));

    await expect(client.getSessionCommand(target, "oi-build", "cmd-1")).resolves.toMatchObject({
      id: "cmd-1",
      exitCode: 1,
    });
    expect(fetchSpy).toHaveBeenLastCalledWith(
      "https://runner.test/toolbox/sb-1/process/session/oi-build/command/cmd-1",
      expect.objectContaining({ method: "GET" })
    );

    fetchSpy.mockResolvedValue(emptyResponse(204));
    await client.deleteProcessSession(target, "oi-build");
    expect(fetchSpy).toHaveBeenLastCalledWith(
      "https://runner.test/toolbox/sb-1/process/session/oi-build",
      expect.objectContaining({ method: "DELETE" })
    );
  });

  it("treats a running command's absent exit code as still running", async () => {
    const client = new DaytonaRestClient(defaultConfig);
    fetchSpy.mockResolvedValue(jsonResponse({ id: "cmd-1", exitCode: null }));

    const command = await client.getSessionCommand(target, "oi-build", "cmd-1");

    expect(command.exitCode ?? null).toBeNull();
  });
});

describe("DaytonaRestClient error reporting", () => {
  const target = { sandboxId: "sb-1", baseUrl: "https://runner.test/toolbox" };

  it("never puts a secret-bearing endpoint's response body on the error", async () => {
    const client = new DaytonaRestClient(defaultConfig);
    fetchSpy.mockResolvedValue(
      new Response('{"command":"python -m runtime","input":"super-secret-token"}', { status: 400 })
    );

    await expect(
      client.sendSessionCommandInput(target, "oi-build", "cmd-1", "super-secret-token")
    ).rejects.toMatchObject({
      name: "DaytonaApiError",
      status: 400,
      message: expect.not.stringContaining("super-secret-token"),
    });
  });

  it("truncates a long provider body and redacts the API key out of it", async () => {
    const client = new DaytonaRestClient(defaultConfig);
    fetchSpy.mockResolvedValue(
      new Response(`bearer test-api-key rejected ${"x".repeat(1000)}`, { status: 500 })
    );

    const error = await rejectedApiError(client.getSandbox("sb-1"));

    expect(error.message).not.toContain("test-api-key");
    expect(error.message).toContain("[redacted]");
    expect(error.message.length).toBeLessThan(400);
    expect(error.message.endsWith("...")).toBe(true);
  });

  it("surfaces rate-limit guidance for reads but never as an automatic retry", async () => {
    const client = new DaytonaRestClient(defaultConfig);
    fetchSpy.mockResolvedValue(
      new Response("slow down", { status: 429, headers: { "retry-after": "12" } })
    );

    const error = await rejectedApiError(client.getSandbox("sb-1"));

    expect(error.status).toBe(429);
    expect(error.retryAfterMs).toBe(12_000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("omits retry guidance when the provider sends none", async () => {
    const client = new DaytonaRestClient(defaultConfig);
    fetchSpy.mockResolvedValue(new Response("slow down", { status: 429 }));

    const error = await rejectedApiError(client.getSandbox("sb-1"));

    expect(error.retryAfterMs).toBeUndefined();
  });
});

describe("Daytona lifecycle state parsing", () => {
  it("maps every documented sandbox state to itself", () => {
    for (const state of DAYTONA_SANDBOX_STATES) {
      expect(parseDaytonaSandboxState(state)).toBe(state);
    }
  });

  it("maps every documented snapshot state to itself", () => {
    for (const state of DAYTONA_SNAPSHOT_STATES) {
      expect(parseDaytonaSnapshotState(state)).toBe(state);
    }
  });

  it("reads an unrecognized state as unknown rather than as ready", () => {
    expect(parseDaytonaSandboxState("warm_pooling")).toBe("unknown");
    expect(parseDaytonaSnapshotState("publishing")).toBe("unknown");
    expect(parseDaytonaSnapshotState("")).toBe("unknown");
  });
});

describe("daytonaBuildResourceName", () => {
  it("derives a bounded provider-safe name from the build id alone", async () => {
    const name = await daytonaBuildResourceName("source", "imgb-acme-repo-1757000000000-ab12");

    expect(name).toMatch(/^oi-source-[0-9a-f]{24}$/);
    expect(name.length).toBeLessThanOrEqual(40);
  });

  it("is stable per build and distinct per kind", async () => {
    const buildId = "imgb-acme-repo-1757000000000-ab12";

    await expect(daytonaBuildResourceName("source", buildId)).resolves.toBe(
      await daytonaBuildResourceName("source", buildId)
    );
    await expect(daytonaBuildResourceName("image", buildId)).resolves.not.toBe(
      await daytonaBuildResourceName("source", buildId)
    );
  });

  it("stays inside the charset for nested owners and long identities", async () => {
    const nested = await daytonaBuildResourceName(
      "image",
      `imgb-${"group/subgroup/deep".repeat(20)}-1757000000000-ab12`
    );

    expect(nested).toMatch(/^[a-z0-9-]+$/);
    expect(nested.length).toBeLessThanOrEqual(40);
  });

  it("gives distinct builds distinct names", async () => {
    const names = await Promise.all([
      daytonaBuildResourceName("source", "imgb-acme-repo-1757000000000-ab12"),
      daytonaBuildResourceName("source", "imgb-acme-repo-1757000000000-ab13"),
      daytonaBuildResourceName("source", "imgb-acme-other-1757000000000-ab12"),
    ]);

    expect(new Set(names).size).toBe(3);
  });
});
