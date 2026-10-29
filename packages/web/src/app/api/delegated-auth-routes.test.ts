import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as SandboxProviderModule from "@/lib/sandbox-provider";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server-auth-session", () => ({ getServerAuthSession: vi.fn() }));
vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));
vi.mock("@/lib/sandbox-provider", async (importOriginal) => ({
  ...(await importOriginal<typeof SandboxProviderModule>()),
  supportsRepoImages: () => true,
  getPublicSandboxProvider: () => "modal",
}));

import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { POST as createAutomation } from "./automations/route";
import {
  PUT as updateAutomation,
  PATCH as updateAutomationExecutor,
} from "./automations/[id]/route";
import { GET as listAutomationInvocations } from "./automations/[id]/invocations/route";
import { POST as pauseAutomation } from "./automations/[id]/pause/route";
import { POST as regenerateAutomationKey } from "./automations/[id]/regenerate-key/route";
import { POST as resumeAutomation } from "./automations/[id]/resume/route";
import { GET as getAutomationRun } from "./automations/[id]/runs/[runId]/route";
import { POST as triggerAutomation } from "./automations/[id]/trigger/route";
import { GET as listEnvironments, POST as createEnvironment } from "./environments/route";
import { PUT as updateEnvironment } from "./environments/[id]/route";
import { POST as triggerEnvironmentImage } from "./environments/[id]/images/trigger/route";
import {
  GET as listEnvironmentSecrets,
  PUT as updateEnvironmentSecrets,
} from "./environments/[id]/secrets/route";
import { DELETE as deleteEnvironmentSecret } from "./environments/[id]/secrets/[key]/route";
import { POST as importEnvironmentSecrets } from "./environments/[id]/secrets/import/route";
import { GET as getImageBuilds } from "./image-builds/route";
import { POST as triggerRepoImage } from "./image-builds/repo/[owner]/[name]/trigger/route";
import { PUT as toggleRepoImage } from "./image-builds/repo/[owner]/[name]/toggle/route";
import { GET as listIntegrationRepos } from "./integration-settings/[id]/repos/route";
import { GET as listSlackChannels } from "./integrations/slack/channels/route";
import { GET as listMcpServers, POST as createMcpServer } from "./mcp-servers/route";
import {
  GET as getMcpServer,
  PUT as updateMcpServer,
  DELETE as deleteMcpServer,
} from "./mcp-servers/[id]/route";
import { GET as listRepos } from "./repos/route";
import { GET as listRepoBranches } from "./repos/[owner]/[name]/branches/route";
import {
  GET as listRepoSecrets,
  PUT as updateRepoSecrets,
} from "./repos/[owner]/[name]/secrets/route";
import { DELETE as deleteRepoSecret } from "./repos/[owner]/[name]/secrets/[key]/route";
import { GET as listGlobalSecrets, PUT as updateGlobalSecrets } from "./secrets/route";
import { DELETE as deleteGlobalSecret } from "./secrets/[key]/route";
import { POST as archiveSession } from "./sessions/[id]/archive/route";
import { POST as createSession } from "./sessions/route";
import { POST as batchArchiveSessions } from "./sessions/batch-archive/route";
import { POST as sendPrompt } from "./sessions/[id]/prompt/route";
import { PATCH as updateSessionReadState } from "./sessions/[id]/read-state/route";
import { POST as updateInboxReadState } from "./sessions/inbox/read-state/route";
import { PATCH as updateSessionBudget } from "./sessions/[id]/budget/route";
import { GET as listChildSessions } from "./sessions/[id]/children/route";
import { POST as refreshPullRequests } from "./sessions/[id]/pull-requests/refresh/route";
import { GET as getSandboxAccess } from "./sessions/[id]/sandbox-access/route";
import { PATCH as updateSessionTitle } from "./sessions/[id]/title/route";
import { POST as unarchiveSession } from "./sessions/[id]/unarchive/route";

const automationParams = { params: Promise.resolve({ id: "auto-1" }) };
const environmentParams = { params: Promise.resolve({ id: "env_1" }) };
const mcpServerParams = { params: Promise.resolve({ id: "server-1" }) };
const repoParams = { params: Promise.resolve({ owner: "acme", name: "web" }) };
const sessionParams = { params: Promise.resolve({ id: "session-1" }) };
const secretsBody = { secrets: { API_KEY: "test-secret" } };

type RouteCase = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  call: (request: NextRequest) => Promise<Response>;
  body?: unknown;
  error?: string;
  headers?: Record<string, string>;
};

const routes: RouteCase[] = [
  { method: "POST", path: "/automations", call: createAutomation, body: { name: "Test" } },
  {
    method: "PUT",
    path: "/automations/auto-1",
    call: (request) => updateAutomation(request, automationParams),
    body: { name: "Updated" },
  },
  {
    method: "PATCH",
    path: "/automations/auto-1",
    call: (request) => updateAutomationExecutor(request, automationParams),
    body: { userId: "user-1" },
  },
  {
    method: "PUT",
    path: "/environments/env_1",
    call: (request) => updateEnvironment(request, environmentParams),
    body: { name: "Updated" },
  },
  {
    method: "POST",
    path: "/sessions",
    call: createSession,
    body: { repoOwner: "acme", repoName: "web" },
  },
  {
    method: "POST",
    path: "/sessions/batch-archive",
    call: batchArchiveSessions,
    body: { sessionIds: ["session-1"] },
    headers: { "Cache-Control": "private, no-store" },
  },
  {
    method: "POST",
    path: "/sessions/session-1/prompt",
    call: (request) => sendPrompt(request, sessionParams),
    body: { content: "Investigate" },
  },
  {
    method: "PATCH",
    path: "/sessions/session-1/read-state",
    call: (request) => updateSessionReadState(request, sessionParams),
    body: { action: "mark_latest_message_read" },
    headers: { "Cache-Control": "private, no-store" },
  },
  {
    method: "POST",
    path: "/sessions/inbox/read-state",
    call: updateInboxReadState,
    body: {},
    headers: { "Cache-Control": "private, no-store" },
  },
  {
    method: "GET",
    path: "/automations/auto-1/invocations",
    call: (request) => listAutomationInvocations(request, automationParams),
  },
  {
    method: "POST",
    path: "/automations/auto-1/pause",
    call: (request) => pauseAutomation(request, automationParams),
  },
  {
    method: "POST",
    path: "/automations/auto-1/regenerate-key",
    call: (request) => regenerateAutomationKey(request, automationParams),
    body: {},
  },
  {
    method: "POST",
    path: "/automations/auto-1/resume",
    call: (request) => resumeAutomation(request, automationParams),
  },
  {
    method: "GET",
    path: "/automations/auto-1/runs/run-1",
    call: (request) =>
      getAutomationRun(request, { params: Promise.resolve({ id: "auto-1", runId: "run-1" }) }),
  },
  {
    method: "POST",
    path: "/automations/auto-1/trigger",
    call: (request) => triggerAutomation(request, automationParams),
  },
  {
    method: "GET",
    path: "/environments",
    call: listEnvironments,
  },
  {
    method: "POST",
    path: "/environments",
    call: createEnvironment,
    body: {
      name: "Test environment",
      repositories: [{ repoOwner: "acme", repoName: "web", baseBranch: "main" }],
    },
  },
  {
    method: "GET",
    path: "/environments/env_1/secrets",
    call: (request) => listEnvironmentSecrets(request, environmentParams),
  },
  {
    method: "PUT",
    path: "/environments/env_1/secrets",
    call: (request) => updateEnvironmentSecrets(request, environmentParams),
    body: secretsBody,
  },
  {
    method: "DELETE",
    path: "/environments/env_1/secrets/API_KEY",
    call: (request) =>
      deleteEnvironmentSecret(request, {
        params: Promise.resolve({ id: "env_1", key: "API_KEY" }),
      }),
  },
  {
    method: "POST",
    path: "/environments/env_1/secrets/import",
    call: (request) => importEnvironmentSecrets(request, environmentParams),
    body: { repoOwner: "acme", repoName: "web", keys: ["API_KEY"] },
  },
  {
    method: "GET",
    path: "/integration-settings/slack/repos",
    call: (request) => listIntegrationRepos(request, { params: Promise.resolve({ id: "slack" }) }),
  },
  {
    method: "GET",
    path: "/mcp-servers",
    call: listMcpServers,
  },
  {
    method: "POST",
    path: "/mcp-servers",
    call: createMcpServer,
    body: { name: "Test server", type: "remote", url: "https://mcp.example.com" },
  },
  {
    method: "GET",
    path: "/mcp-servers/server-1",
    call: (request) => getMcpServer(request, mcpServerParams),
  },
  {
    method: "PUT",
    path: "/mcp-servers/server-1",
    call: (request) => updateMcpServer(request, mcpServerParams),
    body: { name: "Updated server", revision: 1 },
  },
  {
    method: "DELETE",
    path: "/mcp-servers/server-1",
    call: (request) => deleteMcpServer(request, mcpServerParams),
  },
  {
    method: "GET",
    path: "/repos",
    call: listRepos,
    error: "Failed to fetch repositories",
  },
  {
    method: "GET",
    path: "/repos/acme/web/branches",
    call: (request) => listRepoBranches(request, repoParams),
  },
  {
    method: "GET",
    path: "/repos/acme/web/secrets",
    call: (request) => listRepoSecrets(request, repoParams),
  },
  {
    method: "PUT",
    path: "/repos/acme/web/secrets",
    call: (request) => updateRepoSecrets(request, repoParams),
    body: secretsBody,
  },
  {
    method: "DELETE",
    path: "/repos/acme/web/secrets/API_KEY",
    call: (request) =>
      deleteRepoSecret(request, {
        params: Promise.resolve({ owner: "acme", name: "web", key: "API_KEY" }),
      }),
  },
  {
    method: "GET",
    path: "/secrets",
    call: listGlobalSecrets,
  },
  {
    method: "PUT",
    path: "/secrets",
    call: updateGlobalSecrets,
    body: secretsBody,
  },
  {
    method: "DELETE",
    path: "/secrets/API_KEY",
    call: (request) => deleteGlobalSecret(request, { params: Promise.resolve({ key: "API_KEY" }) }),
  },
  {
    method: "POST",
    path: "/sessions/session-1/archive",
    call: (request) => archiveSession(request, sessionParams),
  },
  {
    method: "PATCH",
    path: "/sessions/session-1/budget",
    call: (request) => updateSessionBudget(request, sessionParams),
    body: { maxCostUsd: 25 },
    headers: { "Cache-Control": "private, no-store" },
  },
  {
    method: "GET",
    path: "/sessions/session-1/children",
    call: (request) => listChildSessions(request, sessionParams),
  },
  {
    method: "POST",
    path: "/sessions/session-1/pull-requests/refresh",
    call: (request) => refreshPullRequests(request, sessionParams),
  },
  {
    method: "GET",
    path: "/sessions/session-1/sandbox-access",
    call: (request) => getSandboxAccess(request, sessionParams),
    headers: { "Cache-Control": "private, no-store", Vary: "Cookie" },
  },
  {
    method: "PATCH",
    path: "/sessions/session-1/title",
    call: (request) => updateSessionTitle(request, sessionParams),
    body: { title: "Investigate failing build" },
  },
  {
    method: "POST",
    path: "/sessions/session-1/unarchive",
    call: (request) => unarchiveSession(request, sessionParams),
  },
  {
    method: "GET",
    path: "/integrations/slack/channels",
    call: listSlackChannels,
  },
  {
    method: "POST",
    path: "/environments/env_1/images/trigger",
    call: (request) => triggerEnvironmentImage(request, environmentParams),
  },
  {
    method: "POST",
    path: "/image-builds/repo/acme/web/trigger",
    call: (request) => triggerRepoImage(request, repoParams),
  },
  {
    method: "PUT",
    path: "/image-builds/repo/acme/web/toggle",
    call: (request) => toggleRepoImage(request, repoParams),
    body: { enabled: true },
  },
];

const imageBuildFeeds = [
  { path: "/image-builds/enabled", data: { units: [] } },
  { path: "/image-builds/enabled-repos", data: { repos: [] } },
  { path: "/image-builds/status", data: { images: [] } },
];

describe("delegated route authentication", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // A valid session exposes redundant lookups without short-circuiting the CP request.
    vi.mocked(getServerAuthSession).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(controlPlaneUserFetch).mockImplementation(async () =>
      Response.json({ error: "Unauthorized" }, { status: 401 })
    );
  });

  it.each(routes)(
    "$method /api$path delegates authentication and preserves the control-plane 401",
    async ({ method, path, call, body, error = "Unauthorized", headers }) => {
      const request = new NextRequest(`http://localhost/api${path}`, {
        method,
        headers: {
          Cookie: "openinspect.session_token=invalid-session",
          "Content-Type": "application/json",
          Origin: "http://localhost",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

      const response = await call(request);

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ error });
      expect(getServerAuthSession).not.toHaveBeenCalled();
      expect(controlPlaneUserFetch).toHaveBeenCalledTimes(1);
      for (const [name, value] of Object.entries(headers ?? {})) {
        expect(response.headers.get(name)).toBe(value);
      }
    }
  );

  describe.each([
    ["no cookies", ""],
    [
      "only unrelated cookies",
      "theme=dark; openinspect.state=transaction; openinspect.session_token.attacker=lookalike",
    ],
  ])("requests with %s", (_description, cookie) => {
    it.each(
      routes
        .filter((route) => route.body !== undefined)
        .flatMap((route) =>
          ["{", JSON.stringify(route.body)].map((body) => ({ ...route, rawBody: body }))
        )
    )(
      "$method /api$path rejects before reading $rawBody",
      async ({ method, path, call, rawBody, headers }) => {
        const request = new NextRequest(`http://localhost/api${path}`, {
          method,
          headers: {
            ...(cookie ? { Cookie: cookie } : {}),
            "Content-Type": "application/json",
            Origin: "http://localhost",
          },
          body: rawBody,
        });
        const readJson = vi.spyOn(request, "json");
        const readBody = vi.spyOn(request, "body", "get");

        const response = await call(request);

        expect(response.status).toBe(401);
        await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
        expect(readJson).not.toHaveBeenCalled();
        expect(readBody).not.toHaveBeenCalled();
        expect(request.bodyUsed).toBe(false);
        expect(controlPlaneUserFetch).not.toHaveBeenCalled();
        expect(getServerAuthSession).not.toHaveBeenCalled();
        for (const [name, value] of Object.entries(headers ?? {})) {
          expect(response.headers.get(name)).toBe(value);
        }
      }
    );
  });

  it.each(
    routes.filter((route) => route.body !== undefined && !route.path.endsWith("/regenerate-key"))
  )(
    "$method /api$path preserves malformed JSON handling with supplied credentials",
    async ({ method, path, call }) => {
      const request = new NextRequest(`http://localhost/api${path}`, {
        method,
        headers: {
          Cookie: "__Secure-openinspect.session_token.0=invalid-session",
          "Content-Type": "application/json",
          Origin: "http://localhost",
        },
        body: "{",
      });

      const response = await call(request);

      const badRequestPaths = [
        "/mcp-servers/server-1",
        "/sessions/session-1/title",
        "/sessions/session-1/read-state",
        "/sessions/inbox/read-state",
        "/sessions/batch-archive",
      ];
      expect(response.status).toBe(badRequestPaths.includes(path) ? 400 : 500);
      expect(request.bodyUsed).toBe(true);
      expect(controlPlaneUserFetch).not.toHaveBeenCalled();
      expect(getServerAuthSession).not.toHaveBeenCalled();
    }
  );

  it.each(
    imageBuildFeeds.flatMap(({ path }) => [
      { path, otherStatus: 200 },
      { path, otherStatus: 503 },
      { path, otherStatus: "rejected" as const },
    ])
  )(
    "GET /api/image-builds preserves a 401 from $path when other feeds return $otherStatus",
    async ({ path: unauthorizedPath, otherStatus }) => {
      vi.mocked(controlPlaneUserFetch).mockImplementation(async (path) => {
        if (path === unauthorizedPath) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }
        if (otherStatus === "rejected") throw new Error("Feed request failed");
        const feed = imageBuildFeeds.find((candidate) => candidate.path === path);
        if (!feed) throw new Error(`Unexpected control-plane path: ${path}`);
        return Response.json(feed.data, { status: otherStatus });
      });

      const response = await getImageBuilds();

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
      expect(getServerAuthSession).not.toHaveBeenCalled();
      expect(controlPlaneUserFetch).toHaveBeenCalledTimes(3);
      expect(vi.mocked(controlPlaneUserFetch).mock.calls.map(([path]) => path)).toEqual(
        imageBuildFeeds.map(({ path }) => path)
      );
    }
  );

  it.each(imageBuildFeeds)(
    "GET /api/image-builds preserves the 500 fallback when $path rejects without a 401",
    async ({ path: rejectedPath }) => {
      vi.mocked(controlPlaneUserFetch).mockImplementation(async (path) => {
        if (path === rejectedPath) throw new Error("Feed request failed");
        const feed = imageBuildFeeds.find((candidate) => candidate.path === path);
        if (!feed) throw new Error(`Unexpected control-plane path: ${path}`);
        return Response.json(feed.data);
      });

      const response = await getImageBuilds();

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: "Failed to fetch image builds" });
      expect(getServerAuthSession).not.toHaveBeenCalled();
      expect(controlPlaneUserFetch).toHaveBeenCalledTimes(3);
    }
  );

  it.each(["upstream error", "transport error"])(
    "GET /api/integrations/slack/channels keeps the 200 fallback on %s",
    async (failure) => {
      if (failure === "upstream error") {
        vi.mocked(controlPlaneUserFetch).mockResolvedValue(Response.json({}, { status: 503 }));
      } else {
        vi.mocked(controlPlaneUserFetch).mockRejectedValue(new Error("Unavailable"));
      }

      const response = await listSlackChannels();

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ channels: [], error: "fetch_failed" });
      expect(getServerAuthSession).not.toHaveBeenCalled();
      expect(controlPlaneUserFetch).toHaveBeenCalledTimes(1);
    }
  );
});
