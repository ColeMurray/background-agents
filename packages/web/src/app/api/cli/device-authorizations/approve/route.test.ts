import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server-auth-session", () => ({
  getServerAuthSession: vi.fn(),
}));

vi.mock("@/lib/control-plane", () => ({
  controlPlaneUserFetch: vi.fn(),
}));

import { controlPlaneUserFetch } from "@/lib/control-plane";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { POST } from "./route";

function request(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

describe("CLI device authorization approval BFF", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getServerAuthSession).mockResolvedValue({
      user: { id: "user-1", name: "Ada", email: "ada@example.com", image: null },
    });
  });

  it("requires a browser session without contacting the control plane", async () => {
    vi.mocked(getServerAuthSession).mockResolvedValue(null);

    const response = await POST(request({ userCode: "ABCD-EFGH" }));

    expect(response.status).toBe(401);
    expect(controlPlaneUserFetch).not.toHaveBeenCalled();
  });

  it("normalizes and forwards only the user code through the user-authenticated service request", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(new Response(null, { status: 204 }));

    const response = await POST(
      request({ userCode: "  abcd-efgh  ", deviceSecret: "must-not-cross-boundary" })
    );

    expect(response.status).toBe(400);
    expect(controlPlaneUserFetch).not.toHaveBeenCalled();

    const accepted = await POST(request({ userCode: "  abcd-efgh  " }));
    expect(accepted.status).toBe(204);
    expect(controlPlaneUserFetch).toHaveBeenCalledWith(
      "/external/v1/cli/device-authorizations/approve",
      {
        method: "POST",
        body: JSON.stringify({ userCode: "ABCD-EFGH" }),
      }
    );
  });

  it.each([404, 409, 410, 429])("preserves the expected control-plane %i state", async (status) => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ error: "sensitive upstream detail" }, { status })
    );

    const response = await POST(request({ userCode: "ABCD-EFGH" }));

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({
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

  it("rejects malformed codes before forwarding", async () => {
    const response = await POST(request({ userCode: "not-a-code" }));

    expect(response.status).toBe(400);
    expect(controlPlaneUserFetch).not.toHaveBeenCalled();
  });
});
