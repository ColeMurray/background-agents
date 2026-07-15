import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  headers: vi.fn(),
}));

import { headers } from "next/headers";
import { controlPlaneFetch } from "./control-plane";

describe("controlPlaneFetch correlation", () => {
  const originalEnv = { ...process.env };
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.resetAllMocks();
    process.env = {
      ...originalEnv,
      CONTROL_PLANE_URL: "https://control-plane.example",
      INTERNAL_CALLBACK_SECRET: "test-secret",
      NODE_ENV: "development",
    };
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue(Response.json({ ok: true }));
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  it("propagates the current request trace id downstream", async () => {
    vi.mocked(headers).mockResolvedValue(
      new Headers({
        "x-trace-id": "trace-123",
        "x-request-id": "bff-hop-1",
        "x-open-inspect-bff-request-id": "bffhop01",
      })
    );

    await controlPlaneFetch("/sessions", {
      method: "POST",
      headers: { Range: "bytes=0-5" },
      body: JSON.stringify({ ok: true }),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    const forwardedHeaders = new Headers(init?.headers);

    expect(url).toBe("https://control-plane.example/sessions");
    expect(forwardedHeaders.get("x-trace-id")).toBe("trace-123");
    expect(forwardedHeaders.get("x-request-id")).toBeNull();
    expect(forwardedHeaders.get("Range")).toBe("bytes=0-5");
    expect(forwardedHeaders.get("Authorization")).toMatch(/^Bearer /);
  });

  it("merges tuple and Headers option headers without dropping values", async () => {
    vi.mocked(headers).mockResolvedValue(
      new Headers({
        "x-trace-id": "trace-123",
        "x-open-inspect-bff-request-id": "bffhop01",
      })
    );

    await controlPlaneFetch("/sessions", {
      headers: new Headers({ Accept: "application/json" }),
    });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const forwardedHeaders = new Headers(init?.headers);

    expect(forwardedHeaders.get("Accept")).toBe("application/json");
    expect(forwardedHeaders.get("Content-Type")).toBe("application/json");
    expect(forwardedHeaders.get("x-trace-id")).toBe("trace-123");
  });

  it("generates a fresh trace id when the inbound one is invalid", async () => {
    vi.mocked(headers).mockResolvedValue(
      new Headers({
        "x-trace-id": "not a valid trace id",
        "x-request-id": "bff-hop-1",
      })
    );

    await controlPlaneFetch("/sessions");

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const traceId = new Headers(init?.headers).get("x-trace-id");

    expect(traceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(traceId).not.toBe("not a valid trace id");
  });
});
