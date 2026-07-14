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
    fetchSpy.mockResolvedValue(jsonResponse({ sandboxID: "sb-new", templateID: "tmpl-123" }));
    await client.createSandbox({
      templateID: "tmpl-123",
      envVars: { FOO: "bar" },
      metadata: { k: "v" },
      timeout: 3300,
      autoPause: false,
    });
    const [, init] = fetchSpy.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({
      templateID: "tmpl-123",
      envVars: { FOO: "bar" },
      metadata: { k: "v" },
      timeout: 3300,
      autoPause: false,
    });
  });

  it("connect, refresh, timeout endpoints", async () => {
    const client = new E2BRestClient(defaultConfig);
    fetchSpy.mockResolvedValue(
      jsonResponse({ sandboxID: "sb-1", templateID: "tmpl", state: "running" })
    );
    await client.connectSandbox("sb-1", 3300);
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toEqual({ timeout: 3300 });

    fetchSpy.mockResolvedValue(new Response(null, { status: 204 }));
    await client.refreshKeepalive("sb-1", 1800);
    expect(JSON.parse(fetchSpy.mock.calls[1][1].body)).toEqual({ duration: 1800 });

    await client.setTimeout("sb-1", 7200);
    expect(JSON.parse(fetchSpy.mock.calls[2][1].body)).toEqual({ timeout: 7200 });
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
});
