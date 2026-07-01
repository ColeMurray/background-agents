import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRequestMetrics } from "../db/instrumented-d1";
import { RepoImageStore } from "../db/repo-images";
import { repoImageRoutes } from "./repo-images";
import type { Env } from "../types";
import type { RequestContext, Route } from "./shared";
import type { RepositoryAccessResult } from "../source-control";
import type * as SourceControlModule from "../source-control";
import type * as SandboxClientModule from "../sandbox/client";
import type * as VercelProviderModule from "../sandbox/providers/vercel/provider";
import type * as VercelClientModule from "../sandbox/providers/vercel/client";
import type * as OpenComputerProviderModule from "../sandbox/providers/opencomputer-provider";
import type * as OpenComputerClientModule from "../sandbox/opencomputer-rest-client";
import type * as IntegrationSettingsResolutionModule from "../session/integration-settings-resolution";

// handleTriggerBuild resolves the repo's actual default branch (never assumes
// "main") and threads it into the build record + the build backend. The #757
// regression hardcoded "main" in BOTH the Modal and Vercel branches, so these
// tests pin the resolved branch reaching the persisted build and each backend,
// and that a repo which can't be resolved fails instead of building "main".

const scmProvider = vi.hoisted(() => ({
  checkRepositoryAccess: vi.fn(),
  generateCredentialHelperAuth: vi.fn(),
}));

const modalClient = vi.hoisted(() => ({
  buildRepoImage: vi.fn(),
}));

const vercelProvider = vi.hoisted(() => ({
  triggerRepoImageBuild: vi.fn(),
}));

const openComputerProvider = vi.hoisted(() => ({
  triggerRepoImageBuild: vi.fn(),
}));

const integrationSettings = vi.hoisted(() => ({
  resolveSandboxSettings: vi.fn(),
}));

vi.mock("../source-control", async (importOriginal) => {
  const actual = await importOriginal<typeof SourceControlModule>();
  return {
    ...actual,
    createSourceControlProviderFromEnv: vi.fn(() => scmProvider),
  };
});

vi.mock("../sandbox/client", async (importOriginal) => {
  const actual = await importOriginal<typeof SandboxClientModule>();
  return {
    ...actual,
    createModalClient: vi.fn(() => modalClient),
  };
});

vi.mock("../sandbox/providers/vercel/provider", async (importOriginal) => {
  const actual = await importOriginal<typeof VercelProviderModule>();
  return {
    ...actual,
    createVercelProvider: vi.fn(() => vercelProvider),
  };
});

vi.mock("../sandbox/providers/vercel/client", async (importOriginal) => {
  const actual = await importOriginal<typeof VercelClientModule>();
  return {
    ...actual,
    createVercelSandboxClient: vi.fn(() => ({})),
  };
});

vi.mock("../sandbox/providers/opencomputer-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof OpenComputerProviderModule>();
  return {
    ...actual,
    createOpenComputerProvider: vi.fn(() => openComputerProvider),
  };
});

vi.mock("../sandbox/opencomputer-rest-client", async (importOriginal) => {
  const actual = await importOriginal<typeof OpenComputerClientModule>();
  return {
    ...actual,
    createOpenComputerRestClient: vi.fn(() => ({})),
  };
});

vi.mock("../session/integration-settings-resolution", async (importOriginal) => {
  const actual = await importOriginal<typeof IntegrationSettingsResolutionModule>();
  return {
    ...actual,
    resolveSandboxSettings: integrationSettings.resolveSandboxSettings,
  };
});

const TRIGGER_PATH = "/repo-images/trigger/acme/repo";

function triggerRoute(): Route {
  // Match on method as well as pattern so a same-pattern route of another
  // method (or a reordering) can never resolve to the wrong handler.
  const route = repoImageRoutes.find(
    (candidate) => candidate.method === "POST" && candidate.pattern.test(TRIGGER_PATH)
  );
  if (!route) throw new Error("trigger route not found");
  return route;
}

function triggerMatch(): RegExpMatchArray {
  const match = TRIGGER_PATH.match(triggerRoute().pattern);
  if (!match) throw new Error("trigger path did not match route pattern");
  return match;
}

function createContext(): RequestContext {
  return {
    request_id: "request-1",
    trace_id: "trace-1",
    metrics: createRequestMetrics(),
    executionCtx: {
      waitUntil: () => {},
    } as unknown as ExecutionContext,
  };
}

function createModalEnv(): Env {
  return {
    DB: {} as unknown as D1Database,
    SANDBOX_PROVIDER: "modal",
    WORKER_URL: "https://cp.test",
    MODAL_API_SECRET: "modal-secret",
    MODAL_WORKSPACE: "modal-ws",
  } as Env;
}

function createVercelEnv(): Env {
  return {
    DB: {} as unknown as D1Database,
    SANDBOX_PROVIDER: "vercel",
    SCM_PROVIDER: "github",
    WORKER_URL: "https://cp.test",
    INTERNAL_CALLBACK_SECRET: "callback-secret",
    VERCEL_TOKEN: "vercel-token",
    VERCEL_PROJECT_ID: "project-123",
  } as Env;
}

function createOpenComputerEnv(): Env {
  return {
    DB: {} as unknown as D1Database,
    SANDBOX_PROVIDER: "opencomputer",
    SCM_PROVIDER: "github",
    WORKER_URL: "https://cp.test",
    INTERNAL_CALLBACK_SECRET: "callback-secret",
    OPENCOMPUTER_API_URL: "https://opencomputer.test",
    OPENCOMPUTER_API_KEY: "oc-token",
    OPENCOMPUTER_TEMPLATE: "openinspect-runtime",
  } as Env;
}

async function callTrigger(env: Env): Promise<Response> {
  return triggerRoute().handler(
    new Request(`https://test.local${TRIGGER_PATH}`, { method: "POST" }),
    env,
    triggerMatch(),
    createContext()
  );
}

const RESOLVED_REPO: RepositoryAccessResult = {
  repoId: 123,
  repoOwner: "acme",
  repoName: "repo",
  defaultBranch: "develop",
};

describe("POST /repo-images/trigger/:owner/:name", () => {
  // Spy the store boundary so the test asserts the typed registerBuild contract
  // rather than the store's SQL text or bound-argument order.
  const registerBuildSpy = vi.spyOn(RepoImageStore.prototype, "registerBuild");

  beforeEach(() => {
    vi.clearAllMocks();
    registerBuildSpy.mockResolvedValue(undefined);
    modalClient.buildRepoImage.mockResolvedValue({ buildId: "build-1", status: "building" });
    vercelProvider.triggerRepoImageBuild.mockResolvedValue(undefined);
    openComputerProvider.triggerRepoImageBuild.mockResolvedValue(undefined);
    integrationSettings.resolveSandboxSettings.mockResolvedValue({});
    scmProvider.generateCredentialHelperAuth.mockResolvedValue({
      username: "x-access-token",
      password: "clone-token",
    });
  });

  it("threads the resolved default branch into the Modal build backend", async () => {
    scmProvider.checkRepositoryAccess.mockResolvedValue(RESOLVED_REPO);

    const response = await callTrigger(createModalEnv());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      buildId: expect.stringContaining("img-acme-repo-"),
      status: "building",
    });

    // Resolution is keyed off the path params, not a hardcoded branch.
    expect(scmProvider.checkRepositoryAccess).toHaveBeenCalledWith({
      owner: "acme",
      name: "repo",
    });

    // The resolved branch — not "main" — reaches the Modal backend...
    expect(modalClient.buildRepoImage).toHaveBeenCalledTimes(1);
    expect(modalClient.buildRepoImage).toHaveBeenCalledWith(
      expect.objectContaining({
        repoOwner: "acme",
        repoName: "repo",
        defaultBranch: "develop",
        buildTimeoutSeconds: 1800,
      }),
      expect.any(Object)
    );

    // ...and is persisted as the build's base branch.
    expect(registerBuildSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        repoOwner: "acme",
        repoName: "repo",
        provider: "modal",
        baseBranch: "develop",
      })
    );
  });

  it("threads the resolved default branch into the Vercel build backend", async () => {
    scmProvider.checkRepositoryAccess.mockResolvedValue(RESOLVED_REPO);

    const response = await callTrigger(createVercelEnv());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      buildId: expect.stringContaining("img-acme-repo-"),
      status: "building",
    });

    // The resolved branch reaches the Vercel backend...
    expect(vercelProvider.triggerRepoImageBuild).toHaveBeenCalledTimes(1);
    expect(vercelProvider.triggerRepoImageBuild).toHaveBeenCalledWith(
      expect.objectContaining({
        repoOwner: "acme",
        repoName: "repo",
        defaultBranch: "develop",
        cloneToken: "clone-token",
      })
    );

    // ...and is persisted as the build's base branch.
    expect(registerBuildSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        repoOwner: "acme",
        repoName: "repo",
        provider: "vercel",
        baseBranch: "develop",
      })
    );
  });

  it("threads the clone token into the OpenComputer build backend", async () => {
    scmProvider.checkRepositoryAccess.mockResolvedValue(RESOLVED_REPO);

    const response = await callTrigger(createOpenComputerEnv());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      buildId: expect.stringContaining("img-acme-repo-"),
      status: "building",
    });
    expect(scmProvider.generateCredentialHelperAuth).toHaveBeenCalled();
    expect(openComputerProvider.triggerRepoImageBuild).toHaveBeenCalledTimes(1);
    expect(openComputerProvider.triggerRepoImageBuild).toHaveBeenCalledWith(
      expect.objectContaining({
        repoOwner: "acme",
        repoName: "repo",
        defaultBranch: "develop",
        cloneToken: "clone-token",
      })
    );
    expect(registerBuildSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "opencomputer",
        baseBranch: "develop",
      })
    );
  });

  it("resolves and clamps the configured build timeout into the Modal backend", async () => {
    scmProvider.checkRepositoryAccess.mockResolvedValue(RESOLVED_REPO);
    integrationSettings.resolveSandboxSettings.mockResolvedValue({ buildTimeoutSeconds: 5000 });

    const response = await callTrigger(createModalEnv());

    expect(response.status).toBe(200);
    expect(integrationSettings.resolveSandboxSettings).toHaveBeenCalledWith(
      expect.anything(),
      "acme",
      "repo"
    );
    expect(modalClient.buildRepoImage).toHaveBeenCalledWith(
      expect.objectContaining({ buildTimeoutSeconds: 3600 }),
      expect.any(Object)
    );
  });

  it("threads the resolved build timeout into the Vercel backend", async () => {
    scmProvider.checkRepositoryAccess.mockResolvedValue(RESOLVED_REPO);
    integrationSettings.resolveSandboxSettings.mockResolvedValue({ buildTimeoutSeconds: 2400 });

    const response = await callTrigger(createVercelEnv());

    expect(response.status).toBe(200);
    expect(vercelProvider.triggerRepoImageBuild).toHaveBeenCalledWith(
      expect.objectContaining({ buildTimeoutSeconds: 2400 })
    );
  });

  it("returns 404 without building when the repository is not installed", async () => {
    scmProvider.checkRepositoryAccess.mockResolvedValue(null);

    const response = await callTrigger(createModalEnv());

    expect(response.status).toBe(404);
    expect(modalClient.buildRepoImage).not.toHaveBeenCalled();
    expect(registerBuildSpy).not.toHaveBeenCalled();
  });

  it("returns 500 without building when repository resolution fails", async () => {
    scmProvider.checkRepositoryAccess.mockRejectedValue(new Error("github unavailable"));

    const response = await callTrigger(createModalEnv());

    expect(response.status).toBe(500);
    expect(modalClient.buildRepoImage).not.toHaveBeenCalled();
    expect(registerBuildSpy).not.toHaveBeenCalled();
  });
});
