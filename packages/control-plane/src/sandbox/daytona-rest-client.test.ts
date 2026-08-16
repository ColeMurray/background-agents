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
  daytonaSandboxResponseSchema,
  daytonaSignedPreviewUrlResponseSchema,
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

let fetchSpy: ReturnType<typeof vi.fn>;

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

    it("throws when baseSnapshot is missing", () => {
      expect(() => new DaytonaRestClient({ ...defaultConfig, baseSnapshot: "" })).toThrow(
        "requires baseSnapshot"
      );
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
    it("sends GET with port and expiry query param", async () => {
      const client = new DaytonaRestClient(defaultConfig);
      fetchSpy.mockResolvedValue(jsonResponse({ url: "https://preview.test/abc" }));

      const result = await client.getSignedPreviewUrl("sb-1", 8080, 3900);

      expect(fetchSpy).toHaveBeenCalledWith(
        "https://daytona.test/api/sandbox/sb-1/ports/8080/signed-preview-url?expires_in_seconds=3900",
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
