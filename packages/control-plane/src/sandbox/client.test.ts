import { afterEach, describe, expect, it, vi } from "vitest";
import { ModalClient } from "./client";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("ModalClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("parses structured API errors for non-2xx responses", async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () =>
        jsonResponse(
          {
            success: false,
            error: {
              code: "service_unavailable",
              message: "Modal unavailable",
              status_code: 503,
            },
          },
          503
        )
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new ModalClient("test-secret", "test-workspace");

    await expect(
      client.createSandbox({
        sessionId: "session-1",
        sandboxId: "sandbox-1",
        repoOwner: "acme",
        repoName: "repo",
        controlPlaneUrl: "https://control.example",
        sandboxAuthToken: "sandbox-token",
      })
    ).rejects.toMatchObject({
      name: "ModalApiError",
      status: 503,
      code: "service_unavailable",
      message: "Modal unavailable",
    });
  });

  it("retries getLatestSnapshot once on transient 503", async () => {
    const fetchMock = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse({ success: false, error: { message: "temporary" } }, 503))
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            id: "snap-1",
            repoOwner: "acme",
            repoName: "repo",
            baseSha: "abc123",
            status: "ready",
            createdAt: "2026-01-01T00:00:00Z",
          },
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const client = new ModalClient("test-secret", "test-workspace");
    const snapshot = await client.getLatestSnapshot("acme", "repo");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(snapshot?.id).toBe("snap-1");
  });

  it("sends correlation headers on snapshot restore", async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () =>
        jsonResponse({ success: true, data: { sandbox_id: "sandbox-1", modal_object_id: "obj-1" } })
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new ModalClient("test-secret", "test-workspace");

    await client.restoreSandbox(
      {
        snapshotImageId: "img-1",
        sessionId: "session-1",
        sandboxId: "sandbox-1",
        sandboxAuthToken: "sandbox-token",
        controlPlaneUrl: "https://control.example",
        repoOwner: "acme",
        repoName: "repo",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
      },
      {
        trace_id: "trace-123",
        request_id: "request-456",
        session_id: "session-1",
        sandbox_id: "sandbox-1",
      }
    );

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["x-trace-id"]).toBe("trace-123");
    expect(headers["x-request-id"]).toBe("request-456");
    expect(headers["x-session-id"]).toBe("session-1");
    expect(headers["x-sandbox-id"]).toBe("sandbox-1");
  });

  it("forwards timeout_seconds in create sandbox payload", async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () =>
        jsonResponse({
          success: true,
          data: {
            sandbox_id: "sandbox-1",
            modal_object_id: "obj-1",
            status: "created",
            created_at: 123,
          },
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new ModalClient("test-secret", "test-workspace");
    await client.createSandbox({
      sessionId: "session-1",
      sandboxId: "sandbox-1",
      repoOwner: "acme",
      repoName: "repo",
      controlPlaneUrl: "https://control.example",
      sandboxAuthToken: "sandbox-token",
      timeoutSeconds: 3600,
    });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const payload = JSON.parse((init.body as string) ?? "{}");
    expect(payload.timeout_seconds).toBe(3600);
  });
});
