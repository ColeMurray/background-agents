import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  E2BRestClient,
  E2BNotFoundError,
  E2BConflictError,
  E2BApiError,
  type E2BRestConfig,
} from "./e2b-rest-client";

const defaultConfig: E2BRestConfig = {
  apiUrl: "https://api.e2b.app",
  apiKey: "test-api-key",
  templateId: "tmpl-123",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Build a Connect streaming body: each message is flags + big-endian length + JSON. */
function connectStream(messages: Array<{ flags: number; body: unknown }>): Uint8Array {
  const chunks = messages.map(({ flags, body }) => {
    const payload = new TextEncoder().encode(JSON.stringify(body));
    const framed = new Uint8Array(5 + payload.length);
    framed[0] = flags;
    new DataView(framed.buffer).setUint32(1, payload.length);
    framed.set(payload, 5);
    return framed;
  });
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("E2BRestClient", () => {
  it("validates config", () => {
    expect(() => new E2BRestClient({ ...defaultConfig, apiUrl: "" })).toThrow("apiUrl");
    expect(() => new E2BRestClient({ ...defaultConfig, apiKey: "" })).toThrow("apiKey");
    expect(() => new E2BRestClient({ ...defaultConfig, templateId: "" })).toThrow("templateId");
  });

  it("strips trailing slashes and sends X-API-Key", async () => {
    const client = new E2BRestClient({ ...defaultConfig, apiUrl: "https://api.e2b.app///" });
    fetchSpy.mockResolvedValue(
      jsonResponse({ sandboxID: "sb-1", templateID: "tmpl", state: "running" })
    );
    await client.getSandbox("sb-1");
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://api.e2b.app/sandboxes/sb-1");
    expect(init.headers["X-API-Key"]).toBe("test-api-key");
    expect(init.headers.Authorization).toBeUndefined();
  });

  it("createSandbox posts expected body", async () => {
    const client = new E2BRestClient(defaultConfig);
    fetchSpy.mockResolvedValue(
      jsonResponse({
        sandboxID: "sb-new",
        templateID: "tmpl-123",
        domain: null,
        envdAccessToken: null,
      })
    );
    const result = await client.createSandbox({
      templateID: "tmpl-123",
      envVars: { FOO: "bar" },
      metadata: { k: "v" },
      timeoutSeconds: 3300,
      autoPause: false,
    });
    expect(result).toEqual({
      sandboxID: "sb-new",
      templateID: "tmpl-123",
      domain: null,
      envdAccessToken: null,
    });
    const [, init] = fetchSpy.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({
      templateID: "tmpl-123",
      envVars: { FOO: "bar" },
      metadata: { k: "v" },
      timeout: 3300,
      secure: false,
      autoPause: false,
      autoResume: { enabled: false },
    });
  });

  it("create body carries autoPause + autoResume when set", async () => {
    const client = new E2BRestClient(defaultConfig);
    fetchSpy.mockResolvedValue(jsonResponse({ sandboxID: "sb-new", templateID: "tmpl-123" }));
    await client.createSandbox({
      templateID: "tmpl-123",
      timeoutSeconds: 3300,
      autoPause: true,
      autoResume: true,
    });
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.autoPause).toBe(true);
    expect(body.autoResume).toEqual({ enabled: true });
  });

  it("sends secure:true when requested", async () => {
    const client = new E2BRestClient(defaultConfig);
    fetchSpy.mockResolvedValue(jsonResponse({ sandboxID: "sb-new", templateID: "tmpl-123" }));
    await client.createSandbox({ templateID: "tmpl-123", secure: true });
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body).secure).toBe(true);
  });

  it("writeSessionEnv sends the X-Access-Token header (never anonymous)", async () => {
    const client = new E2BRestClient(defaultConfig);
    fetchSpy.mockResolvedValue(new Response("[]", { status: 200 }));
    await client.writeSessionEnv("sb-1", { FOO: "bar" }, { envdAccessToken: "tok-123" });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain("49983-sb-1.e2b.app");
    expect((init.headers as Record<string, string>)["X-Access-Token"]).toBe("tok-123");
  });

  it("connect + timeout endpoints", async () => {
    const client = new E2BRestClient(defaultConfig);
    // Connect answers with the create-style Sandbox shape (no `state`); the
    // command discards it rather than validating it as a sandbox detail.
    fetchSpy.mockResolvedValue(jsonResponse({ sandboxID: "sb-1", templateID: "tmpl" }));
    await expect(client.connectSandbox("sb-1", 3300)).resolves.toBeUndefined();
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toEqual({ timeout: 3300 });

    fetchSpy.mockResolvedValue(new Response(null, { status: 204 }));
    await client.setSandboxTimeout("sb-1", 7200);
    expect(JSON.parse(fetchSpy.mock.calls[1][1].body)).toEqual({ timeout: 7200 });
  });

  it("commands ignore whatever a success body contains", async () => {
    const client = new E2BRestClient(defaultConfig);
    fetchSpy.mockResolvedValue(jsonResponse({ unexpected: "payload" }));
    await expect(client.pauseSandbox("sb-1")).resolves.toBeUndefined();

    fetchSpy.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(client.killSandbox("sb-1")).resolves.toBeUndefined();
  });

  it("combines a kill caller signal with the request timeout", async () => {
    const client = new E2BRestClient(defaultConfig);
    const controller = new AbortController();
    controller.abort();
    fetchSpy.mockResolvedValue(new Response(null, { status: 204 }));

    await client.killSandbox("sb-1", controller.signal);

    expect(fetchSpy.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(fetchSpy.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it("rejects malformed E2B success responses", async () => {
    const client = new E2BRestClient(defaultConfig);
    fetchSpy.mockResolvedValue(jsonResponse({ sandboxID: "sb-1" }));

    await expect(client.getSandbox("sb-1")).rejects.toMatchObject({
      name: "E2BApiError",
      body: "invalid_response",
    });
  });

  it("rejects a non-JSON success where a parsed body is required", async () => {
    const client = new E2BRestClient(defaultConfig);
    fetchSpy.mockResolvedValue(new Response(null, { status: 204 }));

    await expect(client.getSandbox("sb-1")).rejects.toMatchObject({
      name: "E2BApiError",
      body: "invalid_response",
    });
  });

  it("parses structured E2B error bodies and falls back for malformed ones", async () => {
    const client = new E2BRestClient(defaultConfig);
    // E2B's Error schema types `code` as an integer, not a slug.
    fetchSpy.mockResolvedValue(jsonResponse({ code: 400, message: "Nope" }, 400));

    await expect(client.getSandbox("x")).rejects.toMatchObject({
      body: { code: 400, message: "Nope" },
    });

    fetchSpy.mockResolvedValue(jsonResponse({ code: "bad_request" }, 400));
    await expect(client.getSandbox("x")).rejects.toMatchObject({
      body: '{"code":"bad_request"}',
    });
  });

  it("classifies 404/409/429 errors", async () => {
    const client = new E2BRestClient(defaultConfig);
    fetchSpy.mockResolvedValue(new Response("missing", { status: 404 }));
    await expect(client.getSandbox("x")).rejects.toThrow(E2BNotFoundError);

    fetchSpy.mockResolvedValue(new Response("paused", { status: 409 }));
    await expect(client.pauseSandbox("x")).rejects.toThrow(E2BConflictError);

    fetchSpy.mockResolvedValue(new Response("slow down", { status: 429 }));
    await expect(client.getSandbox("x")).rejects.toThrow(E2BApiError);
  });

  it("surfaces a request-timeout abort as a transient-classifiable timeout error", async () => {
    const client = new E2BRestClient(defaultConfig);
    const abort = new Error("The operation was aborted");
    abort.name = "AbortError";
    fetchSpy.mockRejectedValue(abort);
    // Must contain "timeout" so SandboxProviderError classifies it transient
    // (isTransientNetworkError), not permanent — otherwise it trips the breaker.
    await expect(client.getSandbox("x")).rejects.toThrow(/timeout/i);
  });

  it("getHostnameForPort is deterministic", () => {
    const client = new E2BRestClient(defaultConfig);
    expect(client.getHostnameForPort("abc", 8080)).toBe("https://8080-abc.e2b.app");
  });

  it("pauseSandbox sends no body by default but forwards memory:false for a disk-only pause", async () => {
    const client = new E2BRestClient(defaultConfig);
    fetchSpy.mockResolvedValue(new Response(null, { status: 204 }));
    await client.pauseSandbox("sb-1");
    expect(fetchSpy.mock.calls[0][1].body).toBeUndefined();

    await client.pauseSandbox("sb-1", { memory: false });
    expect(JSON.parse(fetchSpy.mock.calls[1][1].body)).toEqual({ memory: false });
  });

  it("createSnapshot posts to the snapshots endpoint and returns the snapshot id", async () => {
    const client = new E2BRestClient(defaultConfig);
    fetchSpy.mockResolvedValue(
      jsonResponse({ snapshotID: "snap-abc:default", names: ["team/snap:default"] }, 201)
    );
    const snapshot = await client.createSnapshot("sb-1");
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://api.e2b.app/sandboxes/sb-1/snapshots");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({});
    expect(snapshot.snapshotID).toBe("snap-abc:default");
  });

  it("createSnapshot forwards an optional name", async () => {
    const client = new E2BRestClient(defaultConfig);
    fetchSpy.mockResolvedValue(jsonResponse({ snapshotID: "snap-x:default", names: [] }, 201));
    await client.createSnapshot("sb-1", { name: "my-snap" });
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toEqual({ name: "my-snap" });
  });

  it("createSnapshot aborts when the caller's deadline fires", async () => {
    const client = new E2BRestClient(defaultConfig);
    const caller = new AbortController();
    fetchSpy.mockImplementation((_url: string, init: RequestInit) => {
      caller.abort();
      const error = new Error("aborted");
      error.name = "AbortError";
      expect(init.signal?.aborted).toBe(true);
      return Promise.reject(error);
    });
    await expect(client.createSnapshot("sb-1", { signal: caller.signal })).rejects.toThrow(
      /timeout/
    );
  });

  it("startProcess frames the request as a Connect envelope", async () => {
    const client = new E2BRestClient(defaultConfig);
    // envd's Process/Start is server-streaming: bare JSON gets a 415, so the body
    // must be flags + big-endian length + payload.
    const stream = connectStream([
      { flags: 0, body: { event: { start: { pid: 42 } } } },
      { flags: 0, body: { event: { end: { exited: true, status: "exit status 0" } } } },
      { flags: 2, body: {} },
    ]);
    fetchSpy.mockResolvedValue(new Response(stream, { status: 200 }));

    await client.startProcess("sb-1", "echo hi", { envdAccessToken: "tok" });

    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe("https://49983-sb-1.e2b.app/process.Process/Start");
    expect(init.headers["Content-Type"]).toBe("application/connect+json");
    expect(init.headers["X-Access-Token"]).toBe("tok");
    const framed = new Uint8Array(init.body as ArrayBuffer);
    expect(framed[0]).toBe(0);
    const declaredLength = new DataView(framed.buffer).getUint32(1);
    expect(declaredLength).toBe(framed.length - 5);
    expect(JSON.parse(new TextDecoder().decode(framed.subarray(5)))).toEqual({
      process: { cmd: "/bin/sh", args: ["-c", "echo hi"] },
    });
  });

  it("startProcess fails on a non-zero exit reported inside a 200 stream", async () => {
    const client = new E2BRestClient(defaultConfig);
    // envd reports command failures in-band, so the HTTP status proves nothing.
    fetchSpy.mockResolvedValue(
      new Response(
        connectStream([
          { flags: 0, body: { event: { start: { pid: 7 } } } },
          { flags: 0, body: { event: { end: { exited: true, status: "exit status 127" } } } },
          { flags: 2, body: {} },
        ]),
        { status: 200 }
      )
    );

    await expect(client.startProcess("sb-1", "nope", { envdAccessToken: "tok" })).rejects.toThrow(
      /exit status 127/
    );
  });

  it("startProcess surfaces a Connect end-of-stream error", async () => {
    const client = new E2BRestClient(defaultConfig);
    fetchSpy.mockResolvedValue(
      new Response(
        connectStream([
          { flags: 0, body: { event: { start: { pid: 7 } } } },
          { flags: 2, body: { error: { message: "permission denied" } } },
        ]),
        { status: 200 }
      )
    );

    await expect(client.startProcess("sb-1", "nope", { envdAccessToken: "tok" })).rejects.toThrow(
      /permission denied/
    );
  });

  it("startProcess rejects a stream with no clean exit or end-of-stream", async () => {
    const client = new E2BRestClient(defaultConfig);
    // A start event alone proves nothing ran to completion. Treating it as
    // success would let an unconfirmed launcher through to a session that then
    // dies silently on the connecting timeout.
    fetchSpy.mockResolvedValue(
      new Response(connectStream([{ flags: 0, body: { event: { start: { pid: 7 } } } }]), {
        status: 200,
      })
    );
    await expect(client.startProcess("sb-1", "cmd", { envdAccessToken: "tok" })).rejects.toThrow(
      /stream incomplete/
    );

    // Clean exit but no Connect end-of-stream envelope: the protocol requires
    // one on every completed stream, so its absence means the response is cut.
    fetchSpy.mockResolvedValue(
      new Response(
        connectStream([
          { flags: 0, body: { event: { start: { pid: 7 } } } },
          { flags: 0, body: { event: { end: { exited: true, status: "exit status 0" } } } },
        ]),
        { status: 200 }
      )
    );
    await expect(client.startProcess("sb-1", "cmd", { envdAccessToken: "tok" })).rejects.toThrow(
      /stream incomplete/
    );
  });

  it("startProcess rejects truncated and malformed streams", async () => {
    const client = new E2BRestClient(defaultConfig);
    const complete = connectStream([
      { flags: 0, body: { event: { start: { pid: 7 } } } },
      { flags: 0, body: { event: { end: { exited: true, status: "exit status 0" } } } },
      { flags: 2, body: {} },
    ]);
    fetchSpy.mockResolvedValue(
      new Response(complete.subarray(0, complete.length - 3), { status: 200 })
    );
    await expect(client.startProcess("sb-1", "cmd", { envdAccessToken: "tok" })).rejects.toThrow(
      /truncated/
    );

    // Declared length 1, body "{" — parses as neither an event nor an error.
    fetchSpy.mockResolvedValue(
      new Response(new Uint8Array([0, 0, 0, 0, 1, 0x7b]), { status: 200 })
    );
    await expect(client.startProcess("sb-1", "cmd", { envdAccessToken: "tok" })).rejects.toThrow(
      /malformed/
    );
  });

  it("deleteTemplate passes the full snapshot id to E2B", async () => {
    const client = new E2BRestClient(defaultConfig);
    fetchSpy.mockResolvedValue(new Response(null, { status: 204 }));
    await client.deleteTemplate("snap-abc:default");
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://api.e2b.app/templates/snap-abc%3Adefault");
    expect(init.method).toBe("DELETE");
  });
});
