import { sha256Hex, verifyServiceSignature } from "@open-inspect/shared/service-auth";
import { getRouteMatcher } from "next/dist/shared/lib/router/utils/route-matcher";
import { getRouteRegex } from "next/dist/shared/lib/router/utils/route-regex";
import { cookies, headers } from "next/headers";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ cookies: vi.fn(), headers: vi.fn() }));

import * as automation from "./automations/[id]/route";
import * as invocations from "./automations/[id]/invocations/route";
import * as pause from "./automations/[id]/pause/route";
import * as regenerateKey from "./automations/[id]/regenerate-key/route";
import * as resume from "./automations/[id]/resume/route";
import * as run from "./automations/[id]/runs/[runId]/route";
import * as trigger from "./automations/[id]/trigger/route";
import * as environment from "./environments/[id]/route";
import * as environmentSecrets from "./environments/[id]/secrets/route";
import * as environmentSecret from "./environments/[id]/secrets/[key]/route";
import * as mcpServer from "./mcp-servers/[id]/route";
import * as branches from "./repos/[owner]/[name]/branches/route";
import * as repoSecret from "./repos/[owner]/[name]/secrets/[key]/route";
import * as secret from "./secrets/[key]/route";
import * as archive from "./sessions/[id]/archive/route";
import * as budget from "./sessions/[id]/budget/route";
import * as children from "./sessions/[id]/children/route";
import * as prompt from "./sessions/[id]/prompt/route";
import * as refreshPullRequests from "./sessions/[id]/pull-requests/refresh/route";
import * as readState from "./sessions/[id]/read-state/route";
import * as sandboxAccess from "./sessions/[id]/sandbox-access/route";
import * as title from "./sessions/[id]/title/route";
import * as unarchive from "./sessions/[id]/unarchive/route";
import * as wsToken from "./sessions/[id]/ws-token/route";

const defaultParams = {
  id: "resource-1",
  runId: "run-1",
  owner: "acme",
  name: "web",
  key: "API_KEY",
};
type RouteParams = typeof defaultParams;
type Handler = (
  request: NextRequest,
  context: { params: Promise<RouteParams> }
) => Promise<Response>;

const routes: {
  path: string;
  handlers: Record<string, Handler>;
  body?: unknown;
}[] = [
  { path: "/automations/[id]", handlers: automation },
  { path: "/automations/[id]/invocations", handlers: invocations },
  { path: "/automations/[id]/pause", handlers: pause },
  { path: "/automations/[id]/regenerate-key", handlers: regenerateKey },
  { path: "/automations/[id]/resume", handlers: resume },
  { path: "/automations/[id]/runs/[runId]", handlers: run },
  { path: "/automations/[id]/trigger", handlers: trigger },
  { path: "/environments/[id]", handlers: environment },
  { path: "/environments/[id]/secrets", handlers: environmentSecrets },
  { path: "/environments/[id]/secrets/[key]", handlers: environmentSecret },
  { path: "/mcp-servers/[id]", handlers: mcpServer },
  { path: "/repos/[owner]/[name]/branches", handlers: branches },
  { path: "/repos/[owner]/[name]/secrets/[key]", handlers: repoSecret },
  { path: "/secrets/[key]", handlers: secret },
  { path: "/sessions/[id]/archive", handlers: archive },
  { path: "/sessions/[id]/budget", handlers: budget, body: { maxCostUsd: 25 } },
  { path: "/sessions/[id]/children", handlers: children },
  { path: "/sessions/[id]/prompt", handlers: prompt, body: { content: "Investigate" } },
  { path: "/sessions/[id]/pull-requests/refresh", handlers: refreshPullRequests },
  {
    path: "/sessions/[id]/read-state",
    handlers: readState,
    body: { action: "mark_latest_message_read" },
  },
  { path: "/sessions/[id]/sandbox-access", handlers: sandboxAccess },
  { path: "/sessions/[id]/title", handlers: title, body: { title: "Investigate" } },
  { path: "/sessions/[id]/unarchive", handlers: unarchive },
  { path: "/sessions/[id]/ws-token", handlers: wsToken },
];

const routeCases = routes.flatMap(({ path, handlers, body }) =>
  Object.entries(handlers).flatMap(([method, handler]) =>
    [...path.matchAll(/\[(\w+)\]/g)].map((match) => ({
      path,
      method,
      handler,
      body,
      parameter: match[1] as keyof RouteParams,
    }))
  )
);

describe("delegated resource path boundaries", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("CONTROL_PLANE_URL", "https://control-plane.example");
    vi.stubEnv("SERVICE_AUTH_SECRET", "route-test-secret");
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(headers).mockResolvedValue(new Headers());
    // Only the network is stubbed: cookie serialization, signing and transport are real.
    fetchMock.mockImplementation(async (input) =>
      new URL(String(input)).pathname === "/autofix/activity"
        ? Response.json({ activity: "service-only" })
        : Response.json({ error: "Unauthorized" }, { status: 401 })
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  describe.each([
    "../autofix/activity",
    "..\\autofix\\activity",
    "../../autofix/activity?ignored=1#suffix",
    "%2e%2e/autofix/activity",
  ])("decoded parameter %s", (value) => {
    it.each(routeCases)(
      "$method $path keeps $parameter inside its resource segment",
      async ({ path, method, handler, body, parameter }) => {
        const values = { ...defaultParams, [parameter]: value };
        const requestPath = `/api${path}`.replace(/\[(\w+)\]/g, (_, key: keyof RouteParams) =>
          encodeURIComponent(values[key])
        );
        const request = new NextRequest(`http://localhost${requestPath}`, {
          method,
          headers: {
            Cookie: "openinspect.session_token=invalid-session",
            "Content-Type": "application/json",
          },
          ...(method === "GET" || method === "DELETE" ? {} : { body: JSON.stringify(body ?? {}) }),
        });
        const matched = getRouteMatcher(getRouteRegex(`/api${path}`))(
          new URL(request.url).pathname
        );
        if (!matched) throw new Error(`Route did not match ${requestPath}`);
        expect(matched[parameter]).toBe(value);
        vi.mocked(cookies).mockResolvedValue(request.cookies as never);

        const response = await handler(request, {
          params: Promise.resolve({ ...defaultParams, ...matched } as RouteParams),
        });

        expect(response.status).toBe(401);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0];
        expect(new URL(String(url)).pathname).toBe(requestPath.slice("/api".length));
        const sentHeaders = new Headers(init?.headers);
        expect(sentHeaders.get("Cookie")).toBe("openinspect.session_token=invalid-session");
        const verification = await verifyServiceSignature({
          signatureHeader: sentHeaders.get("X-OpenInspect-Service-Signature") ?? "",
          service: "web",
          secret: "route-test-secret",
          method,
          url: String(url),
          bodySha256Hex: await sha256Hex(typeof init?.body === "string" ? init.body : ""),
          actor: "",
        });
        expect(verification.ok).toBe(true);
      }
    );
  });

  it("preserves nested repository owners as one signed route segment", async () => {
    const request = new NextRequest("http://localhost/api/repos/group%2Fsubgroup/web/branches", {
      headers: { Cookie: "openinspect.session_token=invalid-session" },
    });
    vi.mocked(cookies).mockResolvedValue(request.cookies as never);

    const response = await branches.GET(request, {
      params: Promise.resolve({ owner: "group/subgroup", name: "web" }),
    });

    expect(response.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://control-plane.example/repos/group%2Fsubgroup/web/branches"
    );
  });
});
