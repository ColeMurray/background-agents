import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { GET } from "./route";
import { DELETE, PUT } from "./slack/[channelId]/route";

vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

describe("Team channel bindings proxies", () => {
  it("encodes the team ID and relays the binding list unchanged", async () => {
    const body = {
      bindings: [{ provider: "slack", externalId: "C1", teamId: "team/id", kind: "primary" }],
    };
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(Response.json(body));
    const response = await GET(new NextRequest("http://localhost/api/teams/id/channel-bindings"), {
      params: Promise.resolve({ id: "team/id" }),
    });
    expect(controlPlaneUserFetch).toHaveBeenCalledWith(
      "/teams/team%2Fid/channel-bindings",
      undefined
    );
    expect(await response.json()).toEqual(body);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it.each([401, 403, 404])("preserves an upstream list denial (%s)", async (status) => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ error: "Denied" }, { status })
    );
    const response = await GET(new NextRequest("http://localhost/api/teams/id/channel-bindings"), {
      params: Promise.resolve({ id: "team" }),
    });
    expect(response.status).toBe(status);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("forwards the binding kind and preserves server refusal codes", async () => {
    const body = JSON.stringify({ kind: "source" });
    const refusal = { error: "Channel is not joinable", code: "channel_not_joinable" };
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(Response.json(refusal, { status: 409 }));
    const response = await PUT(
      new NextRequest("http://localhost/api/teams/id/channel-bindings/slack/C1", {
        method: "PUT",
        headers: { Cookie: "__Secure-openinspect.session_token=session.signature" },
        body,
      }),
      { params: Promise.resolve({ id: "team/id", channelId: "C/1" }) }
    );
    expect(controlPlaneUserFetch).toHaveBeenCalledWith(
      "/teams/team%2Fid/channel-bindings/slack/C%2F1",
      { method: "PUT", body }
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(refusal);
  });

  it("forwards DELETE without a body and preserves an empty success response", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(new Response(null, { status: 204 }));
    const response = await DELETE(
      new NextRequest("http://localhost/api/teams/id/channel-bindings/slack/C1", {
        method: "DELETE",
      }),
      {
        params: Promise.resolve({ id: "team/id", channelId: "C/1" }),
      }
    );
    expect(controlPlaneUserFetch).toHaveBeenCalledWith(
      "/teams/team%2Fid/channel-bindings/slack/C%2F1",
      { method: "DELETE" }
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
});
