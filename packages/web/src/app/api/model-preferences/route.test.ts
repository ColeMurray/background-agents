import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { GET, PUT } from "./route";

vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));

const context = { params: Promise.resolve(undefined) };

describe("/api/model-preferences", () => {
  beforeEach(() => vi.resetAllMocks());

  it("relays the preferences read as a private, uncacheable response", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ defaultModel: "anthropic/claude-sonnet-5" })
    );

    const response = await GET(new NextRequest("http://localhost/api/model-preferences"), context);

    expect(controlPlaneUserFetch).toHaveBeenCalledWith("/model-preferences", undefined);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ defaultModel: "anthropic/claude-sonnet-5" });
  });

  it("forwards a preferences update with the browser session", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(Response.json({ ok: true }));
    const request = new NextRequest("http://localhost/api/model-preferences", {
      method: "PUT",
      headers: { Cookie: "__Secure-openinspect.session_token=session.signature" },
      body: JSON.stringify({ defaultModel: "anthropic/claude-opus-5" }),
    });

    const response = await PUT(request, context);

    expect(controlPlaneUserFetch).toHaveBeenCalledWith("/model-preferences", {
      method: "PUT",
      body: JSON.stringify({ defaultModel: "anthropic/claude-opus-5" }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
});
