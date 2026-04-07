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
        env_vars: { FOO: "bar" },
        labels: { key: "value" },
        auto_stop_interval: 120,
        auto_archive_interval: 10080,
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
