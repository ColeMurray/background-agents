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
      Response.json({ repos: [], images: [] })
    );

    const response = await call();

    expect(response.status).toBe(200);
    expect(controlPlaneFetch).toHaveBeenCalled();
  });
});
