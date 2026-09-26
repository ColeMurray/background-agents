import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { controlPlaneUserFetch } from "./control-plane";
import { controlPlaneJsonGetProxy } from "./control-plane-json-proxy";

vi.mock("./control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));

describe("controlPlaneJsonGetProxy", () => {
  const { GET } = controlPlaneJsonGetProxy(() => "/resources", "resources");

  beforeEach(() => vi.resetAllMocks());

  it("forwards JSON status and selected safe headers with private caching", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json(
        { resources: [] },
        {
          status: 202,
          headers: {
            ETag: '"revision-4"',
            "Retry-After": "30",
            "X-Request-Id": "request-1",
            "Set-Cookie": "private=value",
          },
        }
      )
    );

    const response = await GET(new NextRequest("http://localhost/api/resources"));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ resources: [] });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("ETag")).toBe('"revision-4"');
    expect(response.headers.get("Retry-After")).toBe("30");
    expect(response.headers.get("X-Request-Id")).toBe("request-1");
    expect(response.headers.get("Set-Cookie")).toBeNull();
  });

  it("forwards empty no-content responses", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(new Response(null, { status: 204 }));

    const response = await GET(new NextRequest("http://localhost/api/resources"));

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  it("keeps the upstream status when an error body is not JSON", async () => {
    // A gateway or platform layer can answer before the control plane does,
    // with plain text or HTML. The caller acts on the status, so it must not
    // be replaced by a parse failure of the body.
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      new Response("Unauthorized", {
        status: 401,
        headers: { "Content-Type": "text/plain", "X-Request-Id": "request-2" },
      })
    );

    const response = await GET(new NextRequest("http://localhost/api/resources"));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Unexpected response from control plane",
    });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-Request-Id")).toBe("request-2");
  });

  it("answers 502 for a success status whose body is not JSON", async () => {
    // Relaying the 200 would tell the browser the request worked while
    // handing it a body it cannot read.
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      new Response("<html>maintenance</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      })
    );

    const response = await GET(new NextRequest("http://localhost/api/resources"));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "Unexpected response from control plane",
    });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("keeps request failures distinct from upstream responses", async () => {
    vi.mocked(controlPlaneUserFetch).mockRejectedValue(new Error("authentication unavailable"));

    const response = await GET(new NextRequest("http://localhost/api/resources"));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Failed to fetch resources" });
  });
});
