import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { GET, PUT } from "./route";

vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));

const SESSION_COOKIE = "openinspect.session_token=session";
const noParams = { params: Promise.resolve({}) };
const POLICY = JSON.stringify({ enabled: false, maxLifetimeDays: null, allowedPermissions: null });

describe("personal access token policy relay", () => {
  beforeEach(() => vi.resetAllMocks());

  it("reads the policy privately", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(Response.json({ enabled: true }));

    const response = await GET(
      new NextRequest("http://localhost/api/settings/personal-access-token-policy"),
      noParams
    );

    expect(controlPlaneUserFetch).toHaveBeenCalledWith(
      "/settings/personal-access-token-policy",
      undefined,
      { timeoutMs: undefined }
    );
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it.each([undefined, "none", "cross-site", "same-site", "Same-Origin"])(
    "refuses a policy change with %s Fetch Metadata, since it can switch off every token",
    async (site) => {
      const request = new NextRequest(
        "http://localhost/api/settings/personal-access-token-policy",
        {
          method: "PUT",
          headers: {
            Cookie: SESSION_COOKIE,
            "If-Match": '"pat-policy-3"',
            ...(site ? { "Sec-Fetch-Site": site } : {}),
          },
          body: POLICY,
        }
      );

      const response = await PUT(request, noParams);

      expect(response.status).toBe(403);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(request.bodyUsed).toBe(false);
      expect(controlPlaneUserFetch).not.toHaveBeenCalled();
    }
  );

  it("forwards a same-origin change with its revision precondition", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(Response.json({ revision: 4 }));

    const response = await PUT(
      new NextRequest("http://localhost/api/settings/personal-access-token-policy", {
        method: "PUT",
        headers: {
          Cookie: SESSION_COOKIE,
          "Sec-Fetch-Site": "same-origin",
          "If-Match": '"pat-policy-3"',
        },
        body: POLICY,
      }),
      noParams
    );

    expect(controlPlaneUserFetch).toHaveBeenCalledWith(
      "/settings/personal-access-token-policy",
      { method: "PUT", body: POLICY, headers: { "If-Match": '"pat-policy-3"' } },
      { timeoutMs: undefined }
    );
    expect(response.status).toBe(200);
  });
});
