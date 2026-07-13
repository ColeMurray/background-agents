import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRequestMetrics } from "../db/instrumented-d1";
import { ImageBuildStore } from "../db/image-builds";
import { RepoMetadataStore } from "../db/repo-metadata";
import { imageBuildRoutes } from "./image-builds";
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

// The repo trigger resolves the repo's actual default branch (never assumes
// "main") and threads it into the build's repository set + fingerprint + the
// build backend. The #757 regression hardcoded "main" in BOTH the Modal and
// Vercel branches, so these tests pin the resolved branch reaching each
// backend, and that a repo which can't be resolved fails instead of building
// "main". The toggle tests pin the save-hook parity change: toggling a repo's
// prebuild on triggers a build immediately instead of waiting for the cron.

const scmProvider = vi.hoisted(() => ({
  checkRepositoryAccess: vi.fn(),
  generateCredentialHelperAuth: vi.fn(),
}));

const modalClient = vi.hoisted(() => ({
  buildImage: vi.fn(),
}));

const vercelProvider = vi.hoisted(() => ({
  triggerEnvironmentImageBuild: vi.fn(),
}));

const openComputerProvider = vi.hoisted(() => ({
  triggerEnvironmentImageBuild: vi.fn(),
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

const TRIGGER_PATH = "/image-builds/trigger/repo/acme/repo";
const TOGGLE_PATH = "/image-builds/toggle/repo/acme/repo";

function findRoute(method: string, path: string): Route {
  // Match on method as well as pattern so a same-pattern route of another
  // method (or a reordering) can never resolve to the wrong handler.
  const route = imageBuildRoutes.find(
    (candidate) => candidate.method === method && candidate.pattern.test(path)
  );
  if (!route) throw new Error(`route not found: ${method} ${path}`);
  return route;
}

function matchFor(route: Route, path: string): RegExpMatchArray {
  const match = path.match(route.pattern);
  if (!match) throw new Error("path did not match route pattern");
  return match;
}

function createContext(waitUntilTasks?: Promise<unknown>[]): RequestContext {
  return {
    request_id: "request-1",
    trace_id: "trace-1",
    metrics: createRequestMetrics(),
    executionCtx: {
      waitUntil: (task: Promise<unknown>) => {
        waitUntilTasks?.push(task);
      },
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
  const route = findRoute("POST", TRIGGER_PATH);
  return route.handler(
    new Request(`https://test.local${TRIGGER_PATH}`, { method: "POST" }),
    env,
    matchFor(route, TRIGGER_PATH),
    createContext()
  );
}

async function callToggle(
  env: Env,
  body: unknown,
  waitUntilTasks?: Promise<unknown>[]
): Promise<Response> {
  const route = findRoute("PUT", TOGGLE_PATH);
  return route.handler(
    new Request(`https://test.local${TOGGLE_PATH}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
    matchFor(route, TOGGLE_PATH),
    createContext(waitUntilTasks)
  );
}

const RESOLVED_REPO: RepositoryAccessResult = {
  repoId: 123,
  repoOwner: "acme",
  repoName: "repo",
  defaultBranch: "develop",
};

const REPO_REPOSITORIES = [{ repoOwner: "acme", repoName: "repo", baseBranch: "develop" }];

// Spy the store boundary so the tests assert the typed contracts rather than
// the store's SQL text or bound-argument order.
const registerBuildSpy = vi.spyOn(ImageBuildStore.prototype, "registerBuild");
const getActiveBuildSpy = vi.spyOn(ImageBuildStore.prototype, "getActiveBuild");
const hasReadyImageSpy = vi.spyOn(ImageBuildStore.prototype, "hasReadyImageForFingerprint");
const markBuildFailedSpy = vi.spyOn(ImageBuildStore.prototype, "markBuildFailed");
const setImageBuildEnabledSpy = vi.spyOn(RepoMetadataStore.prototype, "setImageBuildEnabled");

beforeEach(() => {
  vi.clearAllMocks();
  registerBuildSpy.mockResolvedValue(true);
  getActiveBuildSpy.mockResolvedValue(null);
  hasReadyImageSpy.mockResolvedValue(false);
  markBuildFailedSpy.mockResolvedValue(true);
  setImageBuildEnabledSpy.mockResolvedValue(undefined);
  modalClient.buildImage.mockResolvedValue({ buildId: "build-1", status: "building" });
  vercelProvider.triggerEnvironmentImageBuild.mockResolvedValue(undefined);
  openComputerProvider.triggerEnvironmentImageBuild.mockResolvedValue(undefined);
  integrationSettings.resolveSandboxSettings.mockResolvedValue({});
  scmProvider.generateCredentialHelperAuth.mockResolvedValue({
    username: "x-access-token",
    password: "clone-token",
  });
});

describe("POST /image-builds/trigger/repo/:owner/:name", () => {
  it("threads the resolved default branch into the Modal build backend", async () => {
    scmProvider.checkRepositoryAccess.mockResolvedValue(RESOLVED_REPO);

    const response = await callTrigger(createModalEnv());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      buildId: expect.stringContaining("imgb-acme-repo-"),
      status: "building",
      alreadyBuilding: false,
    });

    // Resolution is keyed off the path params, not a hardcoded branch.
    expect(scmProvider.checkRepositoryAccess).toHaveBeenCalledWith({
      owner: "acme",
      name: "repo",
    });

    // The resolved branch — not "main" — reaches the Modal backend as the
    // one-element repository set...
    expect(modalClient.buildImage).toHaveBeenCalledTimes(1);
    expect(modalClient.buildImage).toHaveBeenCalledWith(
      expect.objectContaining({
        scopeKind: "repo",
        scopeId: "acme/repo",
        repositories: REPO_REPOSITORIES,
        buildTimeoutSeconds: 1800,
      }),
      expect.any(Object)
    );
    expect(scmProvider.generateCredentialHelperAuth).not.toHaveBeenCalled();

    // ...and is baked into the persisted fingerprint.
    expect(registerBuildSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { kind: "repo", id: "acme/repo" },
        provider: "modal",
        repositoriesFingerprint: expect.any(String),
      })
    );
  });

  it("threads the resolved default branch into the Vercel build backend", async () => {
    scmProvider.checkRepositoryAccess.mockResolvedValue(RESOLVED_REPO);

    const response = await callTrigger(createVercelEnv());

    expect(response.status).toBe(200);
    expect(vercelProvider.triggerEnvironmentImageBuild).toHaveBeenCalledTimes(1);
    expect(vercelProvider.triggerEnvironmentImageBuild).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: "acme/repo",
        repositories: REPO_REPOSITORIES,
        cloneToken: "clone-token",
      })
    );
    expect(registerBuildSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { kind: "repo", id: "acme/repo" },
        provider: "vercel",
        callbackTokenHash: expect.any(String),
      })
    );
  });

  it("threads the clone token into the OpenComputer build backend", async () => {
    scmProvider.checkRepositoryAccess.mockResolvedValue(RESOLVED_REPO);

    const response = await callTrigger(createOpenComputerEnv());

    expect(response.status).toBe(200);
    expect(scmProvider.generateCredentialHelperAuth).toHaveBeenCalled();
    expect(openComputerProvider.triggerEnvironmentImageBuild).toHaveBeenCalledTimes(1);
    expect(openComputerProvider.triggerEnvironmentImageBuild).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: "acme/repo",
        repositories: REPO_REPOSITORIES,
        cloneToken: "clone-token",
      })
    );
    expect(registerBuildSpy).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "opencomputer" })
    );
  });

  it("resolves the repo's sandbox settings without an environment layer and clamps the timeout", async () => {
    scmProvider.checkRepositoryAccess.mockResolvedValue(RESOLVED_REPO);
    integrationSettings.resolveSandboxSettings.mockResolvedValue({ buildTimeoutSeconds: 5000 });

    const response = await callTrigger(createModalEnv());

    expect(response.status).toBe(200);
    expect(integrationSettings.resolveSandboxSettings).toHaveBeenCalledWith(
      expect.anything(),
      "acme",
      "repo"
    );
    expect(modalClient.buildImage).toHaveBeenCalledWith(
      expect.objectContaining({ buildTimeoutSeconds: 3600 }),
      expect.any(Object)
    );
  });

  it("reports the in-flight build instead of stacking another", async () => {
    scmProvider.checkRepositoryAccess.mockResolvedValue(RESOLVED_REPO);
    getActiveBuildSpy.mockResolvedValue({ id: "imgb-acme-repo-existing" });

    const response = await callTrigger(createModalEnv());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      buildId: "imgb-acme-repo-existing",
      status: "building",
      alreadyBuilding: true,
    });
    expect(registerBuildSpy).not.toHaveBeenCalled();
    expect(modalClient.buildImage).not.toHaveBeenCalled();
  });

  it("returns 404 without building when the repository is not installed", async () => {
    scmProvider.checkRepositoryAccess.mockResolvedValue(null);

    const response = await callTrigger(createModalEnv());

    expect(response.status).toBe(404);
    expect(modalClient.buildImage).not.toHaveBeenCalled();
    expect(registerBuildSpy).not.toHaveBeenCalled();
  });

  it("returns 500 without building when repository resolution fails", async () => {
    scmProvider.checkRepositoryAccess.mockRejectedValue(new Error("github unavailable"));

    const response = await callTrigger(createModalEnv());

    expect(response.status).toBe(500);
    expect(modalClient.buildImage).not.toHaveBeenCalled();
    expect(registerBuildSpy).not.toHaveBeenCalled();
  });
});

describe("PUT /image-builds/toggle/repo/:owner/:name", () => {
  it("writes the flag and triggers a stale-checked build on toggle-on", async () => {
    scmProvider.checkRepositoryAccess.mockResolvedValue(RESOLVED_REPO);
    const waitUntilTasks: Promise<unknown>[] = [];

    const response = await callToggle(createModalEnv(), { enabled: true }, waitUntilTasks);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, enabled: true });
    expect(setImageBuildEnabledSpy).toHaveBeenCalledWith("acme", "repo", true);

    // Save-hook parity with environments: the detached triggerBuildIfStale
    // runs behind waitUntil.
    expect(waitUntilTasks).toHaveLength(1);
    await Promise.all(waitUntilTasks);
    expect(registerBuildSpy).toHaveBeenCalledWith(
      expect.objectContaining({ scope: { kind: "repo", id: "acme/repo" } })
    );
    expect(modalClient.buildImage).toHaveBeenCalledTimes(1);
  });

  it("skips the build when a ready image already matches the repository set", async () => {
    scmProvider.checkRepositoryAccess.mockResolvedValue(RESOLVED_REPO);
    hasReadyImageSpy.mockResolvedValue(true);
    const waitUntilTasks: Promise<unknown>[] = [];

    const response = await callToggle(createModalEnv(), { enabled: true }, waitUntilTasks);

    expect(response.status).toBe(200);
    await Promise.all(waitUntilTasks);
    expect(registerBuildSpy).not.toHaveBeenCalled();
    expect(modalClient.buildImage).not.toHaveBeenCalled();
  });

  it("writes the flag without triggering on toggle-off", async () => {
    const waitUntilTasks: Promise<unknown>[] = [];

    const response = await callToggle(createModalEnv(), { enabled: false }, waitUntilTasks);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, enabled: false });
    expect(setImageBuildEnabledSpy).toHaveBeenCalledWith("acme", "repo", false);
    expect(waitUntilTasks).toHaveLength(0);
    expect(scmProvider.checkRepositoryAccess).not.toHaveBeenCalled();
  });

  it("rejects a non-boolean enabled", async () => {
    const response = await callToggle(createModalEnv(), { enabled: "yes" });

    expect(response.status).toBe(400);
    expect(setImageBuildEnabledSpy).not.toHaveBeenCalled();
  });

  it("returns 404 without writing the flag when enabling an uninstalled repo", async () => {
    scmProvider.checkRepositoryAccess.mockResolvedValue(null);
    const waitUntilTasks: Promise<unknown>[] = [];

    const response = await callToggle(createModalEnv(), { enabled: true }, waitUntilTasks);

    expect(response.status).toBe(404);
    expect(setImageBuildEnabledSpy).not.toHaveBeenCalled();
    expect(waitUntilTasks).toHaveLength(0);
  });

  it("returns 500 without writing the flag when enabling and resolution fails", async () => {
    scmProvider.checkRepositoryAccess.mockRejectedValue(new Error("github unavailable"));
    const waitUntilTasks: Promise<unknown>[] = [];

    const response = await callToggle(createModalEnv(), { enabled: true }, waitUntilTasks);

    expect(response.status).toBe(500);
    expect(setImageBuildEnabledSpy).not.toHaveBeenCalled();
    expect(waitUntilTasks).toHaveLength(0);
  });

  it("disables without resolving so an unresolvable repo stays disableable", async () => {
    scmProvider.checkRepositoryAccess.mockRejectedValue(new Error("github unavailable"));

    const response = await callToggle(createModalEnv(), { enabled: false });

    expect(response.status).toBe(200);
    expect(setImageBuildEnabledSpy).toHaveBeenCalledWith("acme", "repo", false);
    expect(scmProvider.checkRepositoryAccess).not.toHaveBeenCalled();
  });
});
