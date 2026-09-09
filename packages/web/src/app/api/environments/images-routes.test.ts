import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as SandboxProviderModuleNamespace from "@/lib/sandbox-provider";

type SandboxProviderModule = typeof SandboxProviderModuleNamespace;

const mocks = vi.hoisted(() => ({
  supportsRepoImagesValue: true,
}));

vi.mock("@/lib/server-auth-session", () => ({
  getServerAuthSession: vi.fn(),
}));

vi.mock("@/lib/control-plane", () => ({
  controlPlaneUserFetch: vi.fn(),
}));

// Only the provider probe is stubbed; the 501 copy comes from the real module so
// the assertion below pins the message routes actually answer with.
vi.mock("@/lib/sandbox-provider", async (importOriginal) => ({
  ...(await importOriginal<SandboxProviderModule>()),
  supportsRepoImages: () => mocks.supportsRepoImagesValue,
}));

import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { REPO_IMAGES_UNSUPPORTED_MESSAGE } from "@/lib/sandbox-provider";
import { POST as triggerBuild } from "./[id]/images/trigger/route";

const request = {} as NextRequest;
const params = { params: Promise.resolve({ id: "env-1" }) };

describe("POST /api/environments/[id]/images/trigger", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.supportsRepoImagesValue = true;
  });

  it("returns 401 before disclosing provider support when unauthenticated", async () => {
    mocks.supportsRepoImagesValue = false;
    vi.mocked(getServerAuthSession).mockResolvedValue(null);

    const response = await triggerBuild(request, params);

    expect(response.status).toBe(401);
    expect(controlPlaneUserFetch).not.toHaveBeenCalled();
  });

  it("returns 501 for authenticated users on a provider without image support", async () => {
    mocks.supportsRepoImagesValue = false;
    vi.mocked(getServerAuthSession).mockResolvedValue({ user: { id: "12345" } } as never);

    const response = await triggerBuild(request, params);

    expect(response.status).toBe(501);
    // Every image-build route answers with the one derived message, so adding a
    // provider cannot leave a stale list behind on some subset of routes.
    expect(await response.json()).toEqual({ error: REPO_IMAGES_UNSUPPORTED_MESSAGE });
    expect(controlPlaneUserFetch).not.toHaveBeenCalled();
  });

  it("posts to the unified environment trigger route", async () => {
    vi.mocked(getServerAuthSession).mockResolvedValue({ user: { id: "12345" } } as never);
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(Response.json({ ok: true }));

    const response = await triggerBuild(request, params);

    expect(response.status).toBe(200);
    expect(controlPlaneUserFetch).toHaveBeenCalledWith("/image-builds/trigger/environment/env-1", {
      method: "POST",
    });
  });
});
