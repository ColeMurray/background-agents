import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { PERSONAL_ACCESS_TOKEN_PREFIX } from "@open-inspect/shared/types/personal-access-tokens";
import { ControlPlaneClient, ControlPlaneError } from "./client";

const TOKEN = `${PERSONAL_ACCESS_TOKEN_PREFIX}${"a".repeat(64)}`;
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

  it("presents the personal access token as a bearer credential", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessions: [] }));
    await new ControlPlaneClient({ baseUrl: BASE_URL, token: TOKEN }).get("/sessions");

    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("sends no service signature, so it cannot be mistaken for a deployed service", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sessions: [] }));
    await new ControlPlaneClient({ baseUrl: BASE_URL, token: TOKEN }).get("/sessions");

    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers["X-OpenInspect-Service"]).toBeUndefined();
    expect(headers["X-OpenInspect-Service-Signature"]).toBeUndefined();
  });

  it("reads with GET", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    await new ControlPlaneClient({ baseUrl: BASE_URL, token: TOKEN }).get("/sessions/s1/events");

    expect(fetchMock.mock.calls[0][1].method).toBe("GET");
  });

  it("appends defined query params and drops undefined ones", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    await new ControlPlaneClient({ baseUrl: BASE_URL, token: TOKEN }).get("/sessions", {
      limit: 20,
      status: undefined,
    });

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.searchParams.get("limit")).toBe("20");
    expect(url.searchParams.has("status")).toBe(false);
  });

  it("reports the status and body when the control plane rejects the token", async () => {
    // A fresh Response per call: a body can only be read once.
    fetchMock.mockImplementation(async () => new Response("Unauthorized", { status: 401 }));
    const client = new ControlPlaneClient({ baseUrl: BASE_URL, token: TOKEN });

    await expect(client.get("/sessions")).rejects.toThrow(ControlPlaneError);
    await expect(client.get("/sessions")).rejects.toThrow(/401/);
  });

  it("reports a transport failure rather than throwing a bare fetch error", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const client = new ControlPlaneClient({ baseUrl: BASE_URL, token: TOKEN });

    await expect(client.get("/sessions")).rejects.toThrow(/ECONNREFUSED/);
  });

  it("keeps the timeout running while the body is read, not just the headers", async () => {
    // fetch() resolves on headers. A body that never completes must still hit
    // the timeout rather than hanging the tool call forever.
    const client = new ControlPlaneClient({ baseUrl: BASE_URL, token: TOKEN, timeoutMs: 50 });
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
    const client = new ControlPlaneClient({ baseUrl: BASE_URL, token: TOKEN });

    // Not reported as a transport failure or as invalid JSON: either would
    // send someone debugging the wrong thing.
    await expect(client.get("/sessions/s1/diff")).rejects.toThrow(/exceeded 8388608 bytes/);
  });

  it("posts a JSON body with the headers the route needs", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ skill: {} }));
    await new ControlPlaneClient({ baseUrl: BASE_URL, token: TOKEN }).post(
      "/skills/s1/reimport",
      { ref: "main" },
      { headers: { "If-Match": '"skillrev_1"' } }
    );

    const [url, init] = fetchMock.mock.calls[0];
    const headers = init.headers as Record<string, string>;
    expect(url).toBe(`${BASE_URL}/skills/s1/reimport`);
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"ref":"main"}');
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["If-Match"]).toBe('"skillrev_1"');
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("sends no body and no content type on a GET", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    await new ControlPlaneClient({ baseUrl: BASE_URL, token: TOKEN }).get("/skills");

    const init = fetchMock.mock.calls[0][1];
    expect(init.body).toBeUndefined();
    expect((init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
  });

  it("names the method in a POST failure, so a 403 is not read as a failed read", async () => {
    fetchMock.mockImplementation(async () => new Response("Forbidden", { status: 403 }));
    const client = new ControlPlaneClient({ baseUrl: BASE_URL, token: TOKEN });

    await expect(client.post("/skills/import", {})).rejects.toThrow(
      /POST \/skills\/import returned 403/
    );
  });

  it("does not double the slash when the base URL has a trailing one", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    await new ControlPlaneClient({ baseUrl: `${BASE_URL}/`, token: TOKEN }).get("/sessions");

    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE_URL}/sessions`);
  });

  it("refuses a plain-http control plane rather than sending the token in cleartext", () => {
    const insecure = { baseUrl: "http://control-plane.example.com", token: TOKEN };
    expect(() => new ControlPlaneClient(insecure)).toThrow(ControlPlaneError);
    // Refused before construction completes, so no request is ever built.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["http://localhost:8787", "http://127.0.0.1:8787", "http://[::1]:8787"])(
    "accepts plain http for a loopback control plane (%s)",
    async (baseUrl) => {
      fetchMock.mockResolvedValue(jsonResponse({}));
      await new ControlPlaneClient({ baseUrl, token: TOKEN }).get("/sessions");

      expect(fetchMock.mock.calls[0][0]).toBe(`${baseUrl}/sessions`);
    }
  );

  it("refuses a base URL that is not a URL at all", () => {
    const malformed = { baseUrl: "control-plane.example.com", token: TOKEN };
    expect(() => new ControlPlaneClient(malformed)).toThrow(/not a valid URL/);
  });

  it("refuses a base URL with a query, which every request would otherwise inherit", () => {
    const withQuery = { baseUrl: `${BASE_URL}/?redirect=evil`, token: TOKEN };
    expect(() => new ControlPlaneClient(withQuery)).toThrow(/query or fragment/);
  });

  it("refuses a value that is not a personal access token, without echoing it", () => {
    const pasted = "ghp_notourtokenbutstillasecret";
    let message = "";
    try {
      new ControlPlaneClient({ baseUrl: BASE_URL, token: pasted });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/not a personal access token/);
    expect(message).not.toContain(pasted);
  });

  it("refuses to follow a redirect, which would carry the token elsewhere", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    await new ControlPlaneClient({ baseUrl: BASE_URL, token: TOKEN }).get("/sessions");

    expect(fetchMock.mock.calls[0][1].redirect).toBe("error");
  });

  it("says what to do when the token is rejected", async () => {
    fetchMock.mockImplementation(async () => new Response("Unauthorized", { status: 401 }));
    const client = new ControlPlaneClient({ baseUrl: BASE_URL, token: TOKEN });

    await expect(client.get("/sessions")).rejects.toThrow(/mistyped, revoked, or expired/);
  });

  it("points at the tool's grant when a resource route refuses for a missing permission", async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse(
        { error: "Forbidden", code: "automation_action_denied", reason_code: "missing_permission" },
        403
      )
    );
    const client = new ControlPlaneClient({ baseUrl: BASE_URL, token: TOKEN });

    await expect(client.post("/automations/a1/trigger", {})).rejects.toThrow(
      /lacks a permission this action needs/
    );
  });

  it("names the permission a token was not granted", async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse(
        { error: "Forbidden", code: "permission_required", permission: "skills.manage" },
        403
      )
    );
    const client = new ControlPlaneClient({ baseUrl: BASE_URL, token: TOKEN });

    await expect(client.post("/skills/import", {})).rejects.toThrow(
      /This token was not granted skills\.manage/
    );
  });
});
