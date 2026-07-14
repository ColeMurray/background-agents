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
import { GET as getFeed } from "./route";
import { POST as triggerBuild } from "./repo/[owner]/[name]/trigger/route";
import { PUT as toggleBuild } from "./repo/[owner]/[name]/toggle/route";

const params = { params: Promise.resolve({ owner: "acme", name: "web" }) };

const routes = [
  { name: "GET /api/image-builds", call: () => getFeed() },
  {
    name: "POST /api/image-builds/repo/[owner]/[name]/trigger",
    call: () => triggerBuild({} as NextRequest, params),
  },
  {
    name: "PUT /api/image-builds/repo/[owner]/[name]/toggle",
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
    // Fresh Response per call — the feed route consumes three bodies.
    vi.mocked(controlPlaneFetch).mockImplementation(async () =>
      Response.json({ units: [], repos: [], images: [] })
    );

    const response = await call();

    expect(response.status).toBe(200);
    expect(controlPlaneFetch).toHaveBeenCalled();
  });
});

describe("GET /api/image-builds feed", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.supportsRepoImagesValue = true;
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: "12345" } } as never);
  });

  it("serves enabled scopes plus cross-scope status, failed rows included", async () => {
    const readyRepoRow = {
      id: "build-1",
      scope_kind: "repo",
      scope_id: "acme/web",
      provider: "modal",
      status: "ready",
      repositories_fingerprint: "fp-repo",
      repository_shas: JSON.stringify([{ repoOwner: "acme", repoName: "web", baseSha: "abc123" }]),
      runtime_version: "60",
      build_duration_seconds: 42.5,
      error_message: null,
      created_at: 1700000000000,
    };
    const failedEnvironmentRow = {
      id: "build-2",
      scope_kind: "environment",
      scope_id: "env_1",
      provider: "modal",
      status: "failed",
      repositories_fingerprint: "fp-env",
      repository_shas: "[]",
      runtime_version: "60",
      build_duration_seconds: null,
      error_message: "boom",
      created_at: 1700000000001,
    };
    vi.mocked(controlPlaneFetch).mockImplementation(async (path: string) => {
      if (path === "/image-builds/enabled") {
        return Response.json({
          units: [
            {
              scopeKind: "repo",
              scopeId: "acme/web",
              repositoriesFingerprint: "fp-repo",
              repositories: [],
            },
            {
              scopeKind: "environment",
              scopeId: "env_1",
              repositoriesFingerprint: "fp-env",
              repositories: [],
            },
          ],
          minRuntimeVersion: 53,
        });
      }
      if (path === "/image-builds/enabled-repos") {
        return Response.json({ repos: [{ repoOwner: "acme", repoName: "web" }] });
      }
      if (path === "/image-builds/status") {
        return Response.json({ images: [readyRepoRow, failedEnvironmentRow] });
      }
      throw new Error(`unexpected control-plane path: ${path}`);
    });

    const response = await getFeed();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      units: [
        { scopeKind: "repo", scopeId: "acme/web", repositoriesFingerprint: "fp-repo" },
        { scopeKind: "environment", scopeId: "env_1", repositoriesFingerprint: "fp-env" },
      ],
      enabledRepos: [{ repoOwner: "acme", repoName: "web" }],
      images: [readyRepoRow, failedEnvironmentRow],
    });
  });

  it("serves persisted repo flags even when unit resolution dropped the repo", async () => {
    vi.mocked(controlPlaneFetch).mockImplementation(async (path: string) => {
      // The repo is enabled but transiently unresolvable, so the units feed
      // omits it — the persisted flag must still come through.
      if (path === "/image-builds/enabled") return Response.json({ units: [] });
      if (path === "/image-builds/enabled-repos") {
        return Response.json({ repos: [{ repoOwner: "acme", repoName: "web" }] });
      }
      return Response.json({ images: [] });
    });

    const response = await getFeed();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      units: [],
      enabledRepos: [{ repoOwner: "acme", repoName: "web" }],
      images: [],
    });
  });

  it("filters superseded rows at the fetch boundary", async () => {
    vi.mocked(controlPlaneFetch).mockImplementation(async (path: string) => {
      if (path === "/image-builds/enabled") return Response.json({ units: [] });
      if (path === "/image-builds/enabled-repos") return Response.json({ repos: [] });
      return Response.json({
        images: [
          {
            id: "build-1",
            scope_kind: "environment",
            scope_id: "env_1",
            provider: "modal",
            status: "superseded",
            repositories_fingerprint: "fp-env",
            repository_shas: "[]",
            runtime_version: "60",
            build_duration_seconds: 10,
            error_message: null,
            created_at: 1700000000000,
          },
        ],
      });
    });

    const response = await getFeed();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ units: [], enabledRepos: [], images: [] });
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
