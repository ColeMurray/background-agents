import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  supportsRepoImagesValue: true,
}));

vi.mock("next-auth", () => ({
  getServerSession: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  authOptions: {},
}));

vi.mock("@/lib/control-plane", () => ({
  controlPlaneFetch: vi.fn(),
}));

vi.mock("@/lib/sandbox-provider", () => ({
  supportsRepoImages: () => mocks.supportsRepoImagesValue,
}));

import { getServerSession } from "next-auth";
import { controlPlaneFetch } from "@/lib/control-plane";
import { GET as getRegistry } from "./route";
import { POST as triggerBuild } from "./[owner]/[name]/trigger/route";
import { PUT as toggleBuild } from "./[owner]/[name]/toggle/route";

const params = { params: Promise.resolve({ owner: "acme", name: "web" }) };

const routes = [
  { name: "GET /api/repo-images", call: () => getRegistry() },
  {
    name: "POST /api/repo-images/[owner]/[name]/trigger",
    call: () => triggerBuild({} as NextRequest, params),
  },
  {
    name: "PUT /api/repo-images/[owner]/[name]/toggle",
    call: () => toggleBuild({ json: async () => ({ enabled: true }) } as NextRequest, params),
  },
];

describe.each(routes)("$name", ({ call }) => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.supportsRepoImagesValue = true;
  });

  it("returns 401 before disclosing provider support when unauthenticated", async () => {
    mocks.supportsRepoImagesValue = false;
    vi.mocked(getServerSession).mockResolvedValue(null);

    const response = await call();

    expect(response.status).toBe(401);
    expect(controlPlaneFetch).not.toHaveBeenCalled();
  });

  it("returns 501 for authenticated users on a provider without image support", async () => {
    mocks.supportsRepoImagesValue = false;
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: "12345" } } as never);

    const response = await call();

    expect(response.status).toBe(501);
    expect(controlPlaneFetch).not.toHaveBeenCalled();
  });

  it("proxies to the control plane for authenticated users", async () => {
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: "12345" } } as never);
    // Fresh Response per call — the registry route consumes two bodies.
    vi.mocked(controlPlaneFetch).mockImplementation(async () =>
      Response.json({ units: [], images: [] })
    );

    const response = await call();

    expect(response.status).toBe(200);
    expect(controlPlaneFetch).toHaveBeenCalled();
  });
});

describe("GET /api/repo-images translation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.supportsRepoImagesValue = true;
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: "12345" } } as never);
  });

  it("reads the unified endpoints and serves the legacy RepoImage shape", async () => {
    vi.mocked(controlPlaneFetch).mockImplementation(async (path: string) => {
      if (path === "/image-builds/enabled-repos") {
        return Response.json({
          repos: [{ repoOwner: "acme", repoName: "web" }],
        });
      }
      if (path === "/image-builds/status") {
        return Response.json({
          images: [
            {
              scope_kind: "repo",
              scope_id: "acme/web",
              status: "ready",
              repository_shas: JSON.stringify([
                { repoOwner: "acme", repoName: "web", baseSha: "abc123" },
              ]),
              build_duration_seconds: 42.5,
              error_message: null,
              created_at: 1700000000000,
            },
            // Environment rows never leak into the repo images registry.
            {
              scope_kind: "environment",
              scope_id: "env_1",
              status: "ready",
              repository_shas: "[]",
              build_duration_seconds: 10,
              error_message: null,
              created_at: 1700000000000,
            },
          ],
        });
      }
      throw new Error(`unexpected control-plane path: ${path}`);
    });

    const response = await getRegistry();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      enabledRepos: ["acme/web"],
      images: [
        {
          repo_owner: "acme",
          repo_name: "web",
          status: "ready",
          base_sha: "abc123",
          build_duration_seconds: 42.5,
          created_at: 1700000000000,
        },
      ],
    });
  });
});

describe("proxied control-plane paths", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.supportsRepoImagesValue = true;
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: "12345" } } as never);
    vi.mocked(controlPlaneFetch).mockImplementation(async () => Response.json({ ok: true }));
  });

  it("trigger posts to the unified repo trigger route", async () => {
    await triggerBuild({} as NextRequest, params);

    expect(controlPlaneFetch).toHaveBeenCalledWith("/image-builds/trigger/repo/acme/web", {
      method: "POST",
    });
  });

  it("toggle puts to the unified repo toggle route", async () => {
    await toggleBuild({ json: async () => ({ enabled: true }) } as NextRequest, params);

    expect(controlPlaneFetch).toHaveBeenCalledWith("/image-builds/toggle/repo/acme/web", {
      method: "PUT",
      body: JSON.stringify({ enabled: true }),
    });
  });
});
