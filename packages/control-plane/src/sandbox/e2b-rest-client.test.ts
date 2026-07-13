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

  it("getHostnameForPort is deterministic", () => {
    const client = new E2BRestClient(defaultConfig);
    expect(client.getHostnameForPort("abc", 8080)).toBe("https://8080-abc.e2b.app");
  });
});

describe("E2BRestClient — template builds", () => {
  it("createTemplate posts name + resources and returns ids", async () => {
    const client = new E2BRestClient(defaultConfig);
    fetchSpy.mockResolvedValue(
      jsonResponse({
        templateID: "tpl-9",
        buildID: "build-1",
        names: ["team/oi-repo-acme-web:default"],
      })
    );
    const created = await client.createTemplate("oi-repo-acme-web", {
      cpuCount: 2,
      memoryMB: 1024,
    });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://api.e2b.app/v3/templates");
    expect(JSON.parse(init.body)).toEqual({
      name: "oi-repo-acme-web",
      cpuCount: 2,
      memoryMB: 1024,
    });
    expect(created.templateID).toBe("tpl-9");
    expect(created.buildID).toBe("build-1");
  });

  it("startTemplateBuild posts fromTemplate, steps, start/ready cmds", async () => {
    const client = new E2BRestClient(defaultConfig);
    fetchSpy.mockResolvedValue(new Response(null, { status: 202 }));
    await client.startTemplateBuild("tpl-9", "build-1", {
      fromTemplate: "open-inspect-sandbox",
      steps: [{ type: "RUN", args: ["git clone https://example.com/repo /workspace/repo"] }],
      startCmd: "python /usr/local/bin/oi-launch",
      readyCmd: "command -v python",
    });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://api.e2b.app/v2/templates/tpl-9/builds/build-1");
    expect(JSON.parse(init.body)).toEqual({
      fromTemplate: "open-inspect-sandbox",
      steps: [{ type: "RUN", args: ["git clone https://example.com/repo /workspace/repo"] }],
      startCmd: "python /usr/local/bin/oi-launch",
      readyCmd: "command -v python",
    });
  });

  it("getTemplateBuildStatus returns build info", async () => {
    const client = new E2BRestClient(defaultConfig);
    fetchSpy.mockResolvedValue(
      jsonResponse({ templateID: "tpl-9", buildID: "build-1", status: "ready" })
    );
    const info = await client.getTemplateBuildStatus("tpl-9", "build-1");
    expect(fetchSpy.mock.calls[0][0]).toBe(
      "https://api.e2b.app/templates/tpl-9/builds/build-1/status"
    );
    expect(info.status).toBe("ready");
  });

  it("deleteTemplate targets the un-namespaced name", async () => {
    const client = new E2BRestClient(defaultConfig);
    fetchSpy.mockResolvedValue(new Response(null, { status: 204 }));
    await client.deleteTemplate("oi-repo-acme-web");
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://api.e2b.app/templates/oi-repo-acme-web");
    expect(init.method).toBe("DELETE");
  });

  it("template endpoints surface API errors", async () => {
    const client = new E2BRestClient(defaultConfig);
    fetchSpy.mockResolvedValue(new Response("nope", { status: 404 }));
    await expect(client.getTemplateBuildStatus("tpl-9", "build-1")).rejects.toThrow(
      E2BNotFoundError
    );
  });
});
