import { sha256Hex, verifyServiceSignature } from "@open-inspect/shared/service-auth";
import { cookies, headers } from "next/headers";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PUT as moveSession } from "./route";
import { PUT as changeVisibility } from "../visibility/route";
import {
  PUT as addCollaborator,
  DELETE as removeCollaborator,
} from "../collaborators/[userId]/route";

vi.mock("next/headers", () => ({ cookies: vi.fn(), headers: vi.fn() }));

const fetchMock = vi.fn<typeof fetch>();
const sessionCookie = "__Secure-openinspect.session_token=session.signature";
const context = { params: Promise.resolve({ id: "session/id", userId: "user/id" }) };

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("CONTROL_PLANE_URL", "https://control-plane.example");
  vi.stubEnv("SERVICE_AUTH_SECRET", "web-signing-secret");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockResolvedValue(Response.json({ ok: true }));
  vi.mocked(headers).mockResolvedValue(new Headers({ "x-trace-id": "scope-test" }));
  vi.mocked(cookies).mockResolvedValue({
    getAll: () => [
      { name: "__Secure-openinspect.session_token", value: "session.signature" },
      { name: "unrelated", value: "do-not-forward" },
    ],
  } as never);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("session scope BFF service identity", () => {
  it.each([
    {
      handler: moveSession,
      path: "/sessions/session%2Fid/scope",
      method: "PUT",
      body: JSON.stringify({ teamId: "target", includeChildren: true, joinTeam: false }),
    },
    {
      handler: changeVisibility,
      path: "/sessions/session%2Fid/visibility",
      method: "PUT",
      body: JSON.stringify({ visibility: "private", includeChildren: false }),
    },
    {
      handler: addCollaborator,
      path: "/sessions/session%2Fid/collaborators/user%2Fid",
      method: "PUT",
      body: undefined,
    },
    {
      handler: removeCollaborator,
      path: "/sessions/session%2Fid/collaborators/user%2Fid",
      method: "DELETE",
      body: undefined,
    },
  ])("signs the exact $method $path request with browser session identity", async (route) => {
    const response = await route.handler(
      new NextRequest(`http://localhost/api${route.path}`, {
        method: route.method,
        body: route.body,
        headers: {
          Cookie: sessionCookie,
          Authorization: "Bearer caller-controlled",
          "X-OpenInspect-Service": "modal",
          "X-OpenInspect-Service-Signature": "caller-controlled",
          "X-OpenInspect-Actor": "caller-controlled",
        },
      }),
      context
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    const sentHeaders = new Headers(init?.headers);
    expect(url).toBe(`https://control-plane.example${route.path}`);
    expect(init?.method).toBe(route.method);
    expect(init?.body ?? "").toBe(route.body ?? "");
    expect(sentHeaders.get("Cookie")).toBe(sessionCookie);
    expect(sentHeaders.get("Authorization")).toBeNull();
    expect(sentHeaders.get("X-OpenInspect-Actor")).toBeNull();
    expect(sentHeaders.get("X-OpenInspect-Service")).toBe("web");
    const verification = await verifyServiceSignature({
      signatureHeader: sentHeaders.get("X-OpenInspect-Service-Signature") ?? "",
      service: "web",
      secret: "web-signing-secret",
      method: route.method,
      url: String(url),
      bodySha256Hex: await sha256Hex(route.body ?? ""),
      actor: "",
    });
    expect(verification.ok).toBe(true);
  });

  it("rejects DELETE without a browser session before dispatching a service request", async () => {
    vi.mocked(cookies).mockResolvedValue({ getAll: () => [] } as never);
    const response = await removeCollaborator(
      new NextRequest("http://localhost/api/sessions/s1/collaborators/user", { method: "DELETE" }),
      context
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
