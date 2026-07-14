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
import { GET as getEnvironmentStatus } from "./[id]/images/route";
import { POST as triggerBuild } from "./[id]/images/trigger/route";

const request = {} as NextRequest;
const params = { params: Promise.resolve({ id: "env-1" }) };

const routes = [
  {
    name: "GET /api/environments/[id]/images",
    call: () => getEnvironmentStatus(request, params),
  },
  {
    name: "POST /api/environments/[id]/images/trigger",
    call: () => triggerBuild(request, params),
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
    vi.mocked(controlPlaneFetch).mockImplementation(async () => Response.json({ images: [] }));

    const response = await call();

    expect(response.status).toBe(200);
    expect(controlPlaneFetch).toHaveBeenCalledTimes(1);
  });
});

describe("unified route consumption", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.supportsRepoImagesValue = true;
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: "12345" } } as never);
  });

  it("status reads the per-scope unified status and filters superseded rows", async () => {
    const readyRow = {
      id: "build-1",
      scope_kind: "environment",
      scope_id: "env-1",
      provider: "modal",
      status: "ready",
      repository_shas: "[]",
      runtime_version: "60",
      build_duration_seconds: 10,
      error_message: null,
      created_at: 1700000000000,
    };
    vi.mocked(controlPlaneFetch).mockResolvedValue(
      Response.json({ images: [readyRow, { ...readyRow, id: "build-0", status: "superseded" }] })
    );

    const response = await getEnvironmentStatus(request, params);

    expect(controlPlaneFetch).toHaveBeenCalledWith(
      "/image-builds/status?scope_kind=environment&scope_id=env-1"
    );
    await expect(response.json()).resolves.toEqual({ images: [readyRow] });
  });

  it("trigger posts to the unified environment trigger route", async () => {
    vi.mocked(controlPlaneFetch).mockResolvedValue(Response.json({ ok: true }));

    await triggerBuild(request, params);

    expect(controlPlaneFetch).toHaveBeenCalledWith("/image-builds/trigger/environment/env-1", {
      method: "POST",
    });
  });
});
