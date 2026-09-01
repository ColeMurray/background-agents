import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server-auth-session", () => ({ getServerAuthSession: vi.fn() }));
vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));

import { controlPlaneUserFetch } from "@/lib/control-plane";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { GET } from "./route";

function request(userCode: string): NextRequest {
  return {
    nextUrl: new URL(
      `https://app.test/api/cli/device-authorizations/pending?user_code=${userCode}`
    ),
  } as unknown as NextRequest;
}

describe("CLI pending device authorization BFF", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getServerAuthSession).mockResolvedValue({
      user: { id: "user-1", name: "Ada", email: "ada@example.com", image: null },
    });
  });

  it("requires a browser session", async () => {
    vi.mocked(getServerAuthSession).mockResolvedValue(null);
    expect((await GET(request("ABCD-EFGH"))).status).toBe(401);
    expect(controlPlaneUserFetch).not.toHaveBeenCalled();
  });

  it("passes through only validated installation and device metadata", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({
        installation: { name: "Acme Open-Inspect" },
        deviceName: "Ada's laptop",
        expiresAt: 1234,
      })
    );
    const response = await GET(request("abcd-efgh"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      installation: { name: "Acme Open-Inspect" },
      deviceName: "Ada's laptop",
      expiresAt: 1234,
    });
    expect(controlPlaneUserFetch).toHaveBeenCalledWith(
      "/external/v1/cli/device-authorizations/pending?user_code=ABCD-EFGH"
    );
  });

  it.each([404, 409, 410, 429])("preserves safe upstream state %i", async (status) => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(new Response(null, { status }));
    const response = await GET(request("ABCD-EFGH"));
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({
      error:
        status === 404
          ? "invalid"
          : status === 409
            ? "already_used"
            : status === 410
              ? "expired"
              : "rate_limited",
    });
  });

  it("rejects malformed or unsafe upstream data", async () => {
    expect((await GET(request("bad"))).status).toBe(400);
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({
        installation: { name: "Acme Open-Inspect" },
        deviceName: "laptop",
        expiresAt: 1234,
        deviceSecret: "leak",
      })
    );
    expect((await GET(request("ABCD-EFGH"))).status).toBe(503);
  });
});
