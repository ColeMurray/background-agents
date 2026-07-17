import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SuperserveApiError,
  SuperserveNotFoundError,
  createSuperserveRestClient,
} from "./superserve-rest-client";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("SuperserveRestClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates a sandbox with the documented Superserve wire shape", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          id: "provider-id",
          name: "logical-id",
          status: "active",
          access_token: "sandbox-token",
          created_at: "2026-07-17T00:00:00Z",
        },
        201
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = createSuperserveRestClient({
      apiUrl: "https://api.superserve.test/",
      apiKey: "api-key",
      template: "openinspect-runtime",
      sandboxHost: "sandbox.superserve.test",
      autoDeleteSeconds: 604800,
      network: {
        allowOut: ["github.com", "api.anthropic.com"],
        denyOut: ["0.0.0.0/0"],
      },
    });

    const result = await client.createSandbox({
      name: "logical-id",
      envVars: { SANDBOX_ID: "logical-id" },
      metadata: { openinspect_session_id: "session-id" },
      timeoutSeconds: 7200,
    });

    expect(result.id).toBe("provider-id");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.superserve.test/sandboxes");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      "Content-Type": "application/json",
      "X-API-Key": "api-key",
    });
    expect(JSON.parse(String(init.body))).toEqual({
      name: "logical-id",
      from_template: "openinspect-runtime",
      env_vars: { SANDBOX_ID: "logical-id" },
      metadata: { openinspect_session_id: "session-id" },
      timeout_seconds: 7200,
      auto_delete_seconds: 604800,
      network: {
        allow_out: ["github.com", "api.anthropic.com"],
        deny_out: ["0.0.0.0/0"],
      },
    });
  });

  it("launches the runtime through the shared data-plane origin", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ stdout: "123\n", stderr: "", exit_code: 0 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createSuperserveRestClient({
      apiUrl: "https://api.superserve.ai",
      apiKey: "api-key",
      template: "openinspect-runtime",
      sandboxHost: "https://sandbox.superserve.ai/",
    });

    await client.startRuntime(
      "provider-id",
      "sandbox-token",
      { SANDBOX_ID: "logical-id", CONTROL_PLANE_URL: "https://control.test" },
      { "3000": "https://3000-provider-id.sandbox.superserve.ai" }
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://sandbox.superserve.ai/exec");
    expect(init.headers).toMatchObject({
      "X-Access-Token": "sandbox-token",
      "X-Superserve-Sandbox-Id": "provider-id",
    });
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.env).toEqual({
      SANDBOX_ID: "logical-id",
      CONTROL_PLANE_URL: "https://control.test",
    });
    expect(body.command).toContain("TUNNEL_SANDBOX_ID=logical-id");
    expect(body.command).toContain("TUNNEL_3000=https://3000-provider-id");
    expect(body.command).toContain("pgrep -f '[s]andbox_runtime[.]entrypoint'");
    expect(body.command).toContain('nohup python3 -m "$runtime_module"');
  });

  it("uses the per-sandbox boxd hostname for custom data-plane hosts", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ stdout: "", stderr: "", exit_code: 0 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createSuperserveRestClient({
      apiUrl: "https://api.example.test",
      apiKey: "api-key",
      template: "runtime",
      sandboxHost: "sandboxes.example.test",
    });

    await client.startRuntime("provider-id", "sandbox-token");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://boxd-provider-id.sandboxes.example.test/exec");
    expect(init.headers).not.toHaveProperty("X-Superserve-Sandbox-Id");
  });

  it("classifies 404 responses separately", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "gone" }, 404)));
    const client = createSuperserveRestClient({
      apiUrl: "https://api.superserve.ai",
      apiKey: "api-key",
      template: "runtime",
      sandboxHost: "sandbox.superserve.ai",
    });

    await expect(client.activateSandbox("missing")).rejects.toBeInstanceOf(SuperserveNotFoundError);
  });

  it("rejects unsupported preview ports and builds valid URLs", () => {
    const client = createSuperserveRestClient({
      apiUrl: "https://api.superserve.ai",
      apiKey: "api-key",
      template: "runtime",
      sandboxHost: "sandbox.superserve.ai",
    });

    expect(client.getPreviewUrl("provider-id", 8080)).toBe(
      "https://8080-provider-id.sandbox.superserve.ai"
    );
    expect(() => client.getPreviewUrl("provider-id", 80)).toThrow(SuperserveApiError);
  });
});
