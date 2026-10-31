import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { GET, POST } from "./route";
import { DELETE } from "./[id]/route";
import { GET as getPolicy } from "./policy/route";

vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));

const SESSION_COOKIE = "openinspect.session_token=session";
const noParams = { params: Promise.resolve({}) };

describe("personal access token relays", () => {
  beforeEach(() => vi.resetAllMocks());

  it("relays the issued secret without letting any cache keep it", async () => {
    const issued = { id: "token-1", token: `oi_pat_${"a1".repeat(32)}` };
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(Response.json(issued, { status: 201 }));
    const body = JSON.stringify({
      name: "laptop",
      permissions: ["sessions.read"],
      expiresInDays: 30,
    });

    const response = await POST(
      new NextRequest("http://localhost/api/personal-access-tokens", {
        method: "POST",
        headers: { Cookie: SESSION_COOKIE, "Content-Type": "application/json" },
        body,
      }),
      noParams
    );

    expect(controlPlaneUserFetch).toHaveBeenCalledWith(
      "/personal-access-tokens",
      { method: "POST", body },
      { timeoutMs: undefined }
    );
    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual(issued);
  });

  it("lists through the control plane, privately", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(Response.json({ tokens: [] }));

    const response = await GET(
      new NextRequest("http://localhost/api/personal-access-tokens"),
      noParams
    );

    expect(controlPlaneUserFetch).toHaveBeenCalledWith("/personal-access-tokens", undefined, {
      timeoutMs: undefined,
    });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("reads the workspace policy's rules, privately", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(Response.json({ enabled: true }));

    const response = await getPolicy(
      new NextRequest("http://localhost/api/personal-access-tokens/policy"),
      noParams
    );

    expect(controlPlaneUserFetch).toHaveBeenCalledWith(
      "/personal-access-tokens/policy",
      undefined,
      {
        timeoutMs: undefined,
      }
    );
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("revokes by an encoded id, so a crafted id cannot address another route", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(Response.json({ revoked: true }));

    await DELETE(
      new NextRequest("http://localhost/api/personal-access-tokens/x", { method: "DELETE" }),
      { params: Promise.resolve({ id: "../secrets" }) }
    );

    expect(controlPlaneUserFetch).toHaveBeenCalledWith(
      "/personal-access-tokens/..%2Fsecrets",
      { method: "DELETE" },
      { timeoutMs: undefined }
    );
  });
});
