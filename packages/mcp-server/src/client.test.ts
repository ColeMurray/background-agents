import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { verifyServiceSignature, SERVICE_HEADER } from "@open-inspect/shared/service-auth";
import { ControlPlaneClient, ControlPlaneError } from "./client";

const SECRET = "test-secret";
const BASE_URL = "https://control-plane.example.com";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("ControlPlaneClient", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("signs requests as the mcp service with a signature the control plane accepts", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessions: [] }));
    await new ControlPlaneClient({ baseUrl: BASE_URL, secret: SECRET }).get("/sessions");

    const [url, init] = fetchMock.mock.calls[0];
    const headers = init.headers as Record<string, string>;
    expect(headers[SERVICE_HEADER]).toBe("mcp");

    const verification = await verifyServiceSignature({
      signatureHeader: headers["X-OpenInspect-Service-Signature"],
      service: "mcp",
      secret: SECRET,
      method: "GET",
      url,
      bodySha256Hex: await import("@open-inspect/shared/service-auth").then((m) => m.sha256Hex("")),
      actor: "",
    });
    expect(verification.ok).toBe(true);
  });

  it("asserts no actor, so it can never act as a person", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessions: [] }));
    await new ControlPlaneClient({ baseUrl: BASE_URL, secret: SECRET }).get("/sessions");

    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers["X-OpenInspect-Actor"]).toBeUndefined();
  });

  it("sends GET and never a mutating method", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    await new ControlPlaneClient({ baseUrl: BASE_URL, secret: SECRET }).get("/sessions/s1/events");

    expect(fetchMock.mock.calls[0][1].method).toBe("GET");
  });

  it("appends defined query params and drops undefined ones", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    await new ControlPlaneClient({ baseUrl: BASE_URL, secret: SECRET }).get("/sessions", {
      limit: 20,
      status: undefined,
    });

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.searchParams.get("limit")).toBe("20");
    expect(url.searchParams.has("status")).toBe(false);
  });

  it("reports the status and body when the control plane rejects the signature", async () => {
    // A fresh Response per call: a body can only be read once.
    fetchMock.mockImplementation(async () => new Response("Unauthorized", { status: 401 }));
    const client = new ControlPlaneClient({ baseUrl: BASE_URL, secret: SECRET });

    await expect(client.get("/sessions")).rejects.toThrow(ControlPlaneError);
    await expect(client.get("/sessions")).rejects.toThrow(/401/);
  });

  it("reports a transport failure rather than throwing a bare fetch error", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const client = new ControlPlaneClient({ baseUrl: BASE_URL, secret: SECRET });

    await expect(client.get("/sessions")).rejects.toThrow(/ECONNREFUSED/);
  });

  it("keeps the timeout running while the body is read, not just the headers", async () => {
    // fetch() resolves on headers. A body that never completes must still hit
    // the timeout rather than hanging the tool call forever.
    const client = new ControlPlaneClient({ baseUrl: BASE_URL, secret: SECRET, timeoutMs: 50 });
    fetchMock.mockImplementation(
      async (_url: string, init: { signal: AbortSignal }) =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"a":'));
              init.signal.addEventListener("abort", () => controller.error(new Error("aborted")));
            },
          }),
          { status: 200 }
        )
    );

    await expect(client.get("/sessions")).rejects.toThrow(/timed out after 50ms/);
  });

  it("refuses an oversized body instead of buffering it, and says so", async () => {
    const oversized = new Uint8Array(9 * 1024 * 1024);
    fetchMock.mockImplementation(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(oversized);
              controller.close();
            },
          }),
          { status: 200 }
        )
    );
    const client = new ControlPlaneClient({ baseUrl: BASE_URL, secret: SECRET });

    // Not reported as a transport failure or as invalid JSON: either would
    // send someone debugging the wrong thing.
    await expect(client.get("/sessions/s1/diff")).rejects.toThrow(/exceeded 8388608 bytes/);
  });

  it("does not double the slash when the base URL has a trailing one", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    await new ControlPlaneClient({ baseUrl: `${BASE_URL}/`, secret: SECRET }).get("/sessions");

    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE_URL}/sessions`);
  });
});
