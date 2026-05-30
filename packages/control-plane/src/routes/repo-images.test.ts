import { beforeEach, describe, expect, it, vi } from "vitest";
import { repoImageRoutes } from "./repo-images";
import type { RequestContext } from "./shared";
import type { Env } from "../types";

const mockRepoImageStore = {
  registerBuild: vi.fn(),
  getStoredImagesForRepo: vi.fn(),
  deleteStoredImagesForRepo: vi.fn(),
};

const mockModalClient = {
  buildRepoImage: vi.fn(),
  deleteProviderImage: vi.fn(),
};

vi.mock("../db/repo-images", () => ({
  RepoImageStore: vi.fn().mockImplementation(() => mockRepoImageStore),
}));

vi.mock("../sandbox/client", () => ({
  createModalClient: vi.fn(() => mockModalClient),
}));

vi.mock("./shared", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    resolveRepoOrError: vi.fn().mockResolvedValue({
      repoId: 123,
      repoOwner: "acme",
      repoName: "repo",
      defaultBranch: "develop",
    }),
  };
});

function getHandler(method: string, path: string) {
  for (const route of repoImageRoutes) {
    if (route.method === method && route.pattern.test(path)) {
      const match = path.match(route.pattern)!;
      return { handler: route.handler, match };
    }
  }
  throw new Error(`No route found for ${method} ${path}`);
}

function createEnv(): Env {
  return {
    DB: {} as D1Database,
    SANDBOX_PROVIDER: "modal",
    MODAL_API_SECRET: "secret",
    MODAL_WORKSPACE: "workspace",
    WORKER_URL: "https://worker.test",
  } as Env;
}

function createCtx(): RequestContext {
  return {
    trace_id: "trace-1",
    request_id: "req-1",
    metrics: {
      d1Queries: [],
      spans: {},
      time: async <T>(_name: string, fn: () => Promise<T>) => fn(),
      summarize: () => ({}),
    },
  };
}

describe("repo image route handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRepoImageStore.registerBuild.mockResolvedValue(undefined);
    mockRepoImageStore.getStoredImagesForRepo.mockResolvedValue([]);
    mockRepoImageStore.deleteStoredImagesForRepo.mockResolvedValue(0);
    mockModalClient.buildRepoImage.mockResolvedValue({ buildId: "img-test", status: "building" });
    mockModalClient.deleteProviderImage.mockResolvedValue({
      providerImageId: "modal-img-1",
      deleted: true,
    });
  });

  it("uses the resolved repo default branch when triggering a build", async () => {
    const { handler, match } = getHandler("POST", "/repo-images/trigger/acme/repo");

    const response = await handler(
      new Request("https://test.local/repo-images/trigger/acme/repo", { method: "POST" }),
      createEnv(),
      match,
      createCtx()
    );

    expect(response.status).toBe(200);
    expect(mockRepoImageStore.registerBuild).toHaveBeenCalledWith(
      expect.objectContaining({ repoOwner: "acme", repoName: "repo", baseBranch: "develop" })
    );
    expect(mockModalClient.buildRepoImage).toHaveBeenCalledWith(
      expect.objectContaining({ repoOwner: "acme", repoName: "repo", defaultBranch: "develop" }),
      expect.objectContaining({ trace_id: "trace-1", request_id: "req-1" })
    );
  });

  it("deletes provider images before removing stored records", async () => {
    mockRepoImageStore.getStoredImagesForRepo.mockResolvedValue([
      { id: "img-1", provider_image_id: "modal-img-1" },
      { id: "img-2", provider_image_id: "" },
    ]);
    mockRepoImageStore.deleteStoredImagesForRepo.mockResolvedValue(2);

    const { handler, match } = getHandler("DELETE", "/repo-images/acme/repo");

    const response = await handler(
      new Request("https://test.local/repo-images/acme/repo", { method: "DELETE" }),
      createEnv(),
      match,
      createCtx()
    );

    expect(response.status).toBe(200);
    expect(mockModalClient.deleteProviderImage).toHaveBeenCalledWith(
      { providerImageId: "modal-img-1" },
      expect.objectContaining({ trace_id: "trace-1", request_id: "req-1" })
    );
    expect(mockRepoImageStore.deleteStoredImagesForRepo).toHaveBeenCalledWith(["img-1", "img-2"]);
  });
});
