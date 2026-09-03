import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as AuthenticateModule from "../auth/authenticate";
import {
  createTestBackgroundTasks,
  type TestBackgroundTasks,
} from "../background-tasks.test-support";
import { ImageBuildStore } from "../db/image-builds";
import { RepoMetadataStore } from "../db/repo-metadata";
import { imageBuildRoutes } from "./image-builds";
import type { Env } from "../types";
import type { RepositoryAccessResult } from "../source-control";
import type * as SourceControlModule from "../source-control";
import type * as SandboxClientModule from "../sandbox/client";
import type * as VercelProviderModule from "../sandbox/providers/vercel/provider";
import type * as VercelClientModule from "../sandbox/providers/vercel/client";
import type * as OpenComputerProviderModule from "../sandbox/providers/opencomputer-provider";
import type * as OpenComputerClientModule from "../sandbox/opencomputer-rest-client";
import type * as IntegrationSettingsResolutionModule from "../session/integration-settings-resolution";
import {
  createTestRequestHandler,
  ownerAuthorizationDatabase,
  TEST_BACKGROUND_TASK_CONTEXT,
} from "../router.test-support";

// The repo trigger resolves the repo's actual default branch (never assumes
// "main") and threads it into the build's repository set + fingerprint + the
// build backend. The #757 regression hardcoded "main" in BOTH the Modal and
// Vercel branches, so these tests pin the resolved branch reaching each
// backend, and that a repo which can't be resolved fails instead of building
// "main". The toggle tests pin the save-hook parity change: toggling a repo's
// prebuild on triggers a build immediately instead of waiting for the cron.

const mocks = vi.hoisted(() => ({ authenticate: vi.fn() }));

vi.mock("../auth/authenticate", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthenticateModule>()),
  authenticate: mocks.authenticate,
}));

const scmProvider = vi.hoisted(() => ({
  checkRepositoryAccess: vi.fn(),
  generateCredentialHelperAuth: vi.fn(),
}));

const modalClient = vi.hoisted(() => ({
  createImageBuildSandbox: vi.fn(),
  startImageBuildSandbox: vi.fn(),
  terminateImageBuildSandbox: vi.fn(),
}));

const vercelProvider = vi.hoisted(() => ({
  triggerImageBuild: vi.fn(),
}));

const openComputerProvider = vi.hoisted(() => ({
  triggerImageBuild: vi.fn(),
}));

const integrationSettings = vi.hoisted(() => ({
  resolveSandboxSettings: vi.fn(),
}));

const finalizationQueue = {
  send: vi.fn(async () => undefined),
} as unknown as Queue;

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

const handleRequest = createTestRequestHandler([imageBuildRoutes]);

function createModalEnv(): Env {
  return {
    DB: ownerAuthorizationDatabase(),
    SANDBOX_PROVIDER: "modal",
    WORKER_URL: "https://cp.test",
    MODAL_API_SECRET: "modal-secret",
    MODAL_WORKSPACE: "modal-ws",
    IMAGE_BUILD_FINALIZATION_QUEUE: finalizationQueue,
    // Modal builds mint callback tokens like every provider.
    IMAGE_CALLBACK_TOKEN_PEPPER: "test-callback-pepper",
  } as Env;
}

function createVercelEnv(): Env {
  return {
    DB: ownerAuthorizationDatabase(),
    SANDBOX_PROVIDER: "vercel",
    SCM_PROVIDER: "github",
    WORKER_URL: "https://cp.test",
    IMAGE_CALLBACK_TOKEN_PEPPER: "test-callback-pepper",
    VERCEL_TOKEN: "vercel-token",
    VERCEL_PROJECT_ID: "project-123",
    IMAGE_BUILD_FINALIZATION_QUEUE: finalizationQueue,
  } as Env;
}

function createOpenComputerEnv(): Env {
  return {
    DB: ownerAuthorizationDatabase(),
    SANDBOX_PROVIDER: "opencomputer",
    SCM_PROVIDER: "github",
    WORKER_URL: "https://cp.test",
    IMAGE_CALLBACK_TOKEN_PEPPER: "test-callback-pepper",
    OPENCOMPUTER_API_URL: "https://opencomputer.test",
    OPENCOMPUTER_API_KEY: "oc-token",
    OPENCOMPUTER_TEMPLATE: "openinspect-runtime",
    IMAGE_BUILD_FINALIZATION_QUEUE: finalizationQueue,
  } as Env;
}

async function callTrigger(env: Env): Promise<Response> {
  return handleRequest(
    new Request(`https://test.local${TRIGGER_PATH}`, { method: "POST" }),
    env,
    TEST_BACKGROUND_TASK_CONTEXT
  );
}

async function callToggle(
  env: Env,
  body: unknown,
  backgroundTasks: TestBackgroundTasks = createTestBackgroundTasks()
): Promise<Response> {
  return handleRequest(
    new Request(`https://test.local${TOGGLE_PATH}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
    backgroundTasks
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
const bindProviderSessionSpy = vi.spyOn(ImageBuildStore.prototype, "bindProviderSession");
const setImageBuildEnabledSpy = vi.spyOn(RepoMetadataStore.prototype, "setImageBuildEnabled");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authenticate.mockImplementation(async (request: Request) => ({
    principal: { kind: "user", userId: "user-1" },
    request,
  }));
  registerBuildSpy.mockResolvedValue(true);
  getActiveBuildSpy.mockResolvedValue(null);
  hasReadyImageSpy.mockResolvedValue(false);
  markBuildFailedSpy.mockResolvedValue(true);
  setImageBuildEnabledSpy.mockResolvedValue(undefined);
  bindProviderSessionSpy.mockResolvedValue(true);
  modalClient.createImageBuildSandbox.mockResolvedValue({
    providerSessionId: "modal-session-1",
  });
  modalClient.startImageBuildSandbox.mockResolvedValue(undefined);
  modalClient.terminateImageBuildSandbox.mockResolvedValue(undefined);
  vercelProvider.triggerImageBuild.mockResolvedValue(undefined);
  openComputerProvider.triggerImageBuild.mockResolvedValue(undefined);
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
    expect(modalClient.createImageBuildSandbox).toHaveBeenCalledTimes(1);
    expect(modalClient.createImageBuildSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        scopeKind: "repo",
        scopeId: "acme/repo",
        repositories: REPO_REPOSITORIES,
        providerSessionTimeoutSeconds: 2400,
        cloneToken: "clone-token",
      }),
      expect.any(Object)
    );
    expect(bindProviderSessionSpy).toHaveBeenCalledWith(
      expect.stringContaining("imgb-acme-repo-"),
      "modal",
      "modal-session-1"
    );
    expect(modalClient.startImageBuildSandbox).toHaveBeenCalledTimes(1);
    expect(scmProvider.generateCredentialHelperAuth).toHaveBeenCalled();

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
    expect(vercelProvider.triggerImageBuild).toHaveBeenCalledTimes(1);
    expect(vercelProvider.triggerImageBuild).toHaveBeenCalledWith(
      expect.objectContaining({
        scopeKind: "repo",
        scopeId: "acme/repo",
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
    expect(openComputerProvider.triggerImageBuild).toHaveBeenCalledTimes(1);
    expect(openComputerProvider.triggerImageBuild).toHaveBeenCalledWith(
      expect.objectContaining({
        scopeKind: "repo",
        scopeId: "acme/repo",
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
    expect(modalClient.createImageBuildSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ providerSessionTimeoutSeconds: 4200 }),
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
    expect(modalClient.createImageBuildSandbox).not.toHaveBeenCalled();
  });

  it("returns 404 without building when the repository is not installed", async () => {
    scmProvider.checkRepositoryAccess.mockResolvedValue(null);

    const response = await callTrigger(createModalEnv());

    expect(response.status).toBe(404);
    expect(modalClient.createImageBuildSandbox).not.toHaveBeenCalled();
    expect(registerBuildSpy).not.toHaveBeenCalled();
  });

  it("returns 500 without building when repository resolution fails", async () => {
    scmProvider.checkRepositoryAccess.mockRejectedValue(new Error("github unavailable"));

    const response = await callTrigger(createModalEnv());

    expect(response.status).toBe(500);
    expect(modalClient.createImageBuildSandbox).not.toHaveBeenCalled();
    expect(registerBuildSpy).not.toHaveBeenCalled();
  });
});

describe("GET /image-builds/status", () => {
  it.each([
    ["?scope_kind=environment", "scope_id is required with scope_kind"],
    ["?scope_kind=repo&scope_id=", "scope_id is required with scope_kind"],
    ["?scope_id=env_x", "scope_kind must be 'repo' or 'environment'"],
    ["?scope_kind=bogus&scope_id=x", "scope_kind must be 'repo' or 'environment'"],
    ["?scope_kind=repo&scope_kind=repo&scope_id=x", "Invalid scope_kind"],
  ])("rejects the half-pair or malformed scope %s", async (query, error) => {
    const response = await handleRequest(
      new Request(`https://test.local/image-builds/status${query}`),
      createModalEnv(),
      TEST_BACKGROUND_TASK_CONTEXT
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error });
  });
});

describe("PUT /image-builds/toggle/repo/:owner/:name", () => {
  it("writes the flag and triggers a stale-checked build on toggle-on", async () => {
    scmProvider.checkRepositoryAccess.mockResolvedValue(RESOLVED_REPO);
    const backgroundTasks = createTestBackgroundTasks();

    const response = await callToggle(createModalEnv(), { enabled: true }, backgroundTasks);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, enabled: true });
    expect(setImageBuildEnabledSpy).toHaveBeenCalledWith("acme", "repo", true);

    // Save-hook parity with environments: the detached triggerBuildIfStale
    // runs behind waitUntil.
    expect(backgroundTasks.submissions).toHaveLength(1);
    await backgroundTasks.settle();
    expect(registerBuildSpy).toHaveBeenCalledWith(
      expect.objectContaining({ scope: { kind: "repo", id: "acme/repo" } })
    );
    expect(modalClient.createImageBuildSandbox).toHaveBeenCalledTimes(1);
  });

  it("skips the build when a ready image already matches the repository set", async () => {
    scmProvider.checkRepositoryAccess.mockResolvedValue(RESOLVED_REPO);
    hasReadyImageSpy.mockResolvedValue(true);
    const backgroundTasks = createTestBackgroundTasks();

    const response = await callToggle(createModalEnv(), { enabled: true }, backgroundTasks);

    expect(response.status).toBe(200);
    await backgroundTasks.settle();
    expect(registerBuildSpy).not.toHaveBeenCalled();
    expect(modalClient.createImageBuildSandbox).not.toHaveBeenCalled();
  });

  it("writes the flag without triggering on toggle-off", async () => {
    const backgroundTasks = createTestBackgroundTasks();

    const response = await callToggle(createModalEnv(), { enabled: false }, backgroundTasks);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, enabled: false });
    expect(setImageBuildEnabledSpy).toHaveBeenCalledWith("acme", "repo", false);
    expect(backgroundTasks.submissions).toHaveLength(0);
    expect(scmProvider.checkRepositoryAccess).not.toHaveBeenCalled();
  });

  it("rejects a non-boolean enabled", async () => {
    const response = await callToggle(createModalEnv(), { enabled: "yes" });

    expect(response.status).toBe(400);
    expect(setImageBuildEnabledSpy).not.toHaveBeenCalled();
  });

  it("rejects a malformed toggle body", async () => {
    const response = await callToggle(createModalEnv(), null);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "enabled must be a boolean" });
    expect(setImageBuildEnabledSpy).not.toHaveBeenCalled();
  });

  it("returns 404 without writing the flag when enabling an uninstalled repo", async () => {
    scmProvider.checkRepositoryAccess.mockResolvedValue(null);
    const backgroundTasks = createTestBackgroundTasks();

    const response = await callToggle(createModalEnv(), { enabled: true }, backgroundTasks);

    expect(response.status).toBe(404);
    expect(setImageBuildEnabledSpy).not.toHaveBeenCalled();
    expect(backgroundTasks.submissions).toHaveLength(0);
  });

  it("returns 500 without writing the flag when enabling and resolution fails", async () => {
    scmProvider.checkRepositoryAccess.mockRejectedValue(new Error("github unavailable"));
    const backgroundTasks = createTestBackgroundTasks();

    const response = await callToggle(createModalEnv(), { enabled: true }, backgroundTasks);

    expect(response.status).toBe(500);
    expect(setImageBuildEnabledSpy).not.toHaveBeenCalled();
    expect(backgroundTasks.submissions).toHaveLength(0);
  });

  it("disables without resolving so an unresolvable repo stays disableable", async () => {
    scmProvider.checkRepositoryAccess.mockRejectedValue(new Error("github unavailable"));

    const response = await callToggle(createModalEnv(), { enabled: false });

    expect(response.status).toBe(200);
    expect(setImageBuildEnabledSpy).toHaveBeenCalledWith("acme", "repo", false);
    expect(scmProvider.checkRepositoryAccess).not.toHaveBeenCalled();
  });
});
