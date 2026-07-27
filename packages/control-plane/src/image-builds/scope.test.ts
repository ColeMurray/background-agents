import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as SourceControlModule from "../source-control";
import type * as IntegrationSettingsResolutionModule from "../session/integration-settings-resolution";
import type { Env } from "../types";
import { ImageBuildPlanningError, ImageBuildScopeNotFoundError } from "./errors";
import { computeRepositoriesFingerprint } from "./fingerprint";
import { repoImageBuildScope, type ImageBuildScope } from "./model";
import {
  listEnabledScopes,
  listEnabledScopeUnits,
  loadScopeBuildSecrets,
  resolveScopeEnabled,
  resolveScopeSandboxSettings,
  resolveScopeTarget,
  type ResolvedImageBuildTarget,
} from "./scope";

const scmProvider = vi.hoisted(() => ({
  checkRepositoryAccess: vi.fn(),
}));

const integrationSettings = vi.hoisted(() => ({
  resolveSandboxSettings: vi.fn(async () => ({})),
}));

const secretsStores = vi.hoisted(() => ({
  global: vi.fn(async (): Promise<Record<string, string>> => ({})),
  repo: vi.fn(async (_repoId: number): Promise<Record<string, string>> => ({})),
  environment: vi.fn(async (_id: string): Promise<Record<string, string>> => ({})),
}));

vi.mock("../source-control", async (importOriginal) => {
  const actual = await importOriginal<typeof SourceControlModule>();
  return {
    ...actual,
    createSourceControlProviderFromEnv: vi.fn(() => scmProvider),
  };
});

vi.mock("../session/integration-settings-resolution", async (importOriginal) => {
  const actual = await importOriginal<typeof IntegrationSettingsResolutionModule>();
  return {
    ...actual,
    resolveSandboxSettings: integrationSettings.resolveSandboxSettings,
  };
});

vi.mock("../db/global-secrets", () => ({
  GlobalSecretsStore: class {
    getDecryptedSecrets = secretsStores.global;
  },
}));

vi.mock("../db/repo-secrets", () => ({
  RepoSecretsStore: class {
    getDecryptedSecrets = secretsStores.repo;
  },
}));

vi.mock("../db/environment-secrets", () => ({
  EnvironmentSecretsStore: class {
    getDecryptedSecrets = secretsStores.environment;
  },
}));

const REPO_SCOPE: ImageBuildScope = repoImageBuildScope("acme", "web");
const ENV_SCOPE: ImageBuildScope = { kind: "environment", id: "env_1" };

/**
 * Scripted D1 double for the store reads the resolver arms make: environments
 * and environment_repositories (environment arm), repo_metadata (repo arm).
 */
function fakeDb(tables: {
  environment?: Record<string, unknown> | null;
  repositories?: Record<string, unknown>[];
  repoMetadata?: Record<string, { image_build_enabled: number }>;
  enabledRepos?: Array<{ repo_owner: string; repo_name: string }>;
}): D1Database {
  const statement = (sql: string, binds: unknown[] = []) => ({
    bind: (...args: unknown[]) => statement(sql, args),
    first: async () => {
      if (sql.includes("FROM environments")) return tables.environment ?? null;
      if (sql.includes("FROM repo_metadata")) {
        return tables.repoMetadata?.[`${String(binds[0])}/${String(binds[1])}`] ?? null;
      }
      throw new Error(`unexpected first(): ${sql}`);
    },
    all: async () => {
      if (sql.includes("FROM environment_repositories")) {
        return { results: tables.repositories ?? [] };
      }
      if (sql.includes("FROM environments")) {
        return { results: tables.environment ? [tables.environment] : [] };
      }
      if (sql.includes("FROM repo_metadata")) {
        return { results: tables.enabledRepos ?? [] };
      }
      throw new Error(`unexpected all(): ${sql}`);
    },
  });
  return { prepare: statement } as unknown as D1Database;
}

function envWith(db: D1Database, overrides: Partial<Env> = {}): Env {
  return { DB: db, ...overrides } as Env;
}

function repoTarget(repoId = 123): ResolvedImageBuildTarget {
  return {
    kind: "repo",
    repositories: [{ repoOwner: "acme", repoName: "web", baseBranch: "main" }],
    repositoriesFingerprint: "fp-repo",
    repoId,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  integrationSettings.resolveSandboxSettings.mockResolvedValue({});
  secretsStores.global.mockResolvedValue({});
  secretsStores.repo.mockResolvedValue({});
  secretsStores.environment.mockResolvedValue({});
});

describe("resolveScopeTarget", () => {
  it("resolves an environment's repositories in position order with their fingerprint", async () => {
    const db = fakeDb({
      environment: { id: "env_1", prebuild_enabled: 1 },
      repositories: [
        { position: 0, repo_owner: "acme", repo_name: "web", base_branch: "main" },
        { position: 1, repo_owner: "acme", repo_name: "api", base_branch: "develop" },
      ],
    });

    const target = await resolveScopeTarget(envWith(db), db, ENV_SCOPE);

    expect(target.repositories).toEqual([
      { repoOwner: "acme", repoName: "web", baseBranch: "main" },
      { repoOwner: "acme", repoName: "api", baseBranch: "develop" },
    ]);
    expect(target.repositoriesFingerprint).toBe(
      await computeRepositoriesFingerprint(target.repositories)
    );
    // The environment arm carries no repo-only extras.
    expect(target.kind).toBe("environment");
    expect(target).not.toHaveProperty("repoId");
  });

  it("throws scope-not-found for a missing environment", async () => {
    const db = fakeDb({ environment: null });

    await expect(resolveScopeTarget(envWith(db), db, ENV_SCOPE)).rejects.toBeInstanceOf(
      ImageBuildScopeNotFoundError
    );
  });

  it("fails planning on an environment without repositories", async () => {
    const db = fakeDb({ environment: { id: "env_1" }, repositories: [] });

    await expect(resolveScopeTarget(envWith(db), db, ENV_SCOPE)).rejects.toBeInstanceOf(
      ImageBuildPlanningError
    );
  });

  it("resolves a repo scope to a one-element set on the default branch", async () => {
    scmProvider.checkRepositoryAccess.mockResolvedValue({
      repoId: 123,
      repoOwner: "acme",
      repoName: "web",
      defaultBranch: "develop",
    });

    const target = await resolveScopeTarget(envWith(fakeDb({})), fakeDb({}), REPO_SCOPE);

    expect(scmProvider.checkRepositoryAccess).toHaveBeenCalledWith({
      owner: "acme",
      name: "web",
    });
    expect(target.repositories).toEqual([
      { repoOwner: "acme", repoName: "web", baseBranch: "develop" },
    ]);
    expect(target.repositoriesFingerprint).toBe(
      await computeRepositoriesFingerprint(target.repositories)
    );
    // The repo id rides along so the secrets fold (repo_secrets is keyed by
    // it) needs no second source-control round trip.
    expect(target).toMatchObject({ kind: "repo", repoId: 123 });
  });

  it("resolves a repo scope with a nested owner namespace", async () => {
    scmProvider.checkRepositoryAccess.mockResolvedValue({
      repoId: 456,
      repoOwner: "group/subgroup",
      repoName: "web",
      defaultBranch: "main",
    });

    const target = await resolveScopeTarget(
      envWith(fakeDb({})),
      fakeDb({}),
      repoImageBuildScope("group/subgroup", "web")
    );

    expect(scmProvider.checkRepositoryAccess).toHaveBeenCalledWith({
      owner: "group/subgroup",
      name: "web",
    });
    expect(target.repositories).toEqual([
      { repoOwner: "group/subgroup", repoName: "web", baseBranch: "main" },
    ]);
  });

  it("throws scope-not-found when the repository is not installed", async () => {
    scmProvider.checkRepositoryAccess.mockResolvedValue(null);

    await expect(
      resolveScopeTarget(envWith(fakeDb({})), fakeDb({}), REPO_SCOPE)
    ).rejects.toBeInstanceOf(ImageBuildScopeNotFoundError);
  });

  it("fails planning when repository resolution fails", async () => {
    scmProvider.checkRepositoryAccess.mockRejectedValue(new Error("github unavailable"));

    await expect(
      resolveScopeTarget(envWith(fakeDb({})), fakeDb({}), REPO_SCOPE)
    ).rejects.toBeInstanceOf(ImageBuildPlanningError);
  });

  it("fails planning on a malformed repo scope id without touching source control", async () => {
    await expect(
      resolveScopeTarget(envWith(fakeDb({})), fakeDb({}), { kind: "repo", id: "not-a-pair" })
    ).rejects.toBeInstanceOf(ImageBuildPlanningError);
    expect(scmProvider.checkRepositoryAccess).not.toHaveBeenCalled();
  });
});

describe("resolveScopeEnabled", () => {
  it("is true only for an existing, prebuild-enabled environment", async () => {
    expect(
      await resolveScopeEnabled(
        fakeDb({ environment: { id: "env_1", prebuild_enabled: 1 } }),
        ENV_SCOPE
      )
    ).toBe(true);
    expect(
      await resolveScopeEnabled(
        fakeDb({ environment: { id: "env_1", prebuild_enabled: 0 } }),
        ENV_SCOPE
      )
    ).toBe(false);
  });

  it("is false when the environment is gone (a lingering row must never be served)", async () => {
    expect(await resolveScopeEnabled(fakeDb({ environment: null }), ENV_SCOPE)).toBe(false);
  });

  it("reads repo enablement from repo_metadata.image_build_enabled", async () => {
    const db = fakeDb({
      repoMetadata: {
        "acme/web": { image_build_enabled: 1 },
        "acme/api": { image_build_enabled: 0 },
      },
    });

    expect(await resolveScopeEnabled(db, REPO_SCOPE)).toBe(true);
    expect(await resolveScopeEnabled(db, repoImageBuildScope("acme", "api"))).toBe(false);
  });

  it("is false for a repo without a repo_metadata row", async () => {
    expect(await resolveScopeEnabled(fakeDb({}), REPO_SCOPE)).toBe(false);
  });

  it("is false for a malformed repo scope id", async () => {
    expect(await resolveScopeEnabled(fakeDb({}), { kind: "repo", id: "not-a-pair" })).toBe(false);
  });
});

describe("listEnabledScopes", () => {
  it("lists prebuild-enabled environments and repos as scopes", async () => {
    const db = fakeDb({
      environment: { id: "env_1", prebuild_enabled: 1 },
      enabledRepos: [{ repo_owner: "acme", repo_name: "web" }],
    });

    expect(await listEnabledScopes(db)).toEqual([
      { kind: "environment", id: "env_1" },
      { kind: "repo", id: "acme/web" },
    ]);
  });
});

describe("listEnabledScopeUnits", () => {
  it("emits repo units with the default-branch one-element set", async () => {
    scmProvider.checkRepositoryAccess.mockResolvedValue({
      repoId: 123,
      repoOwner: "acme",
      repoName: "web",
      defaultBranch: "main",
    });
    const db = fakeDb({
      environment: { id: "env_1", prebuild_enabled: 1, name: "Env One" },
      repositories: [{ position: 0, repo_owner: "acme", repo_name: "api", base_branch: "dev" }],
      enabledRepos: [{ repo_owner: "acme", repo_name: "web" }],
    });

    const units = await listEnabledScopeUnits(envWith(db), db);

    expect(units).toHaveLength(2);
    expect(units[0].scope).toEqual({ kind: "environment", id: "env_1" });
    expect(units[1]).toEqual({
      scope: { kind: "repo", id: "acme/web" },
      repositories: [{ repoOwner: "acme", repoName: "web", baseBranch: "main" }],
      repositoriesFingerprint: await computeRepositoriesFingerprint([
        { repoOwner: "acme", repoName: "web", baseBranch: "main" },
      ]),
    });
  });

  it("skips a repo unit whose repository cannot be resolved, keeping the rest", async () => {
    scmProvider.checkRepositoryAccess.mockRejectedValue(new Error("github unavailable"));
    const db = fakeDb({
      environment: { id: "env_1", prebuild_enabled: 1, name: "Env One" },
      repositories: [{ position: 0, repo_owner: "acme", repo_name: "api", base_branch: "dev" }],
      enabledRepos: [{ repo_owner: "acme", repo_name: "web" }],
    });

    const units = await listEnabledScopeUnits(envWith(db), db);

    expect(units.map((unit) => unit.scope.kind)).toEqual(["environment"]);
  });
});

describe("resolveScopeSandboxSettings", () => {
  const primary = { repoOwner: "acme", repoName: "web", baseBranch: "main" };

  it("layers the environment's overrides for environment scopes (4-arg)", async () => {
    const db = fakeDb({});
    await resolveScopeSandboxSettings(db, ENV_SCOPE, primary);

    expect(integrationSettings.resolveSandboxSettings).toHaveBeenCalledWith(
      db,
      "acme",
      "web",
      "env_1"
    );
  });

  it("resolves repo scopes without an environment layer (3-arg)", async () => {
    const db = fakeDb({});
    await resolveScopeSandboxSettings(db, REPO_SCOPE, primary);

    expect(integrationSettings.resolveSandboxSettings).toHaveBeenCalledWith(db, "acme", "web");
  });
});

describe("loadScopeBuildSecrets", () => {
  const encryptedEnv = (db: D1Database) => envWith(db, { REPO_SECRETS_ENCRYPTION_KEY: "key" });

  it("returns undefined without an encryption key", async () => {
    expect(
      await loadScopeBuildSecrets(envWith(fakeDb({})), fakeDb({}), REPO_SCOPE, repoTarget())
    ).toBe(undefined);
    expect(secretsStores.global).not.toHaveBeenCalled();
  });

  it("folds global + environment secrets for environment scopes", async () => {
    secretsStores.global.mockResolvedValue({ SHARED: "global", GLOBAL_ONLY: "g" });
    secretsStores.environment.mockResolvedValue({ SHARED: "environment" });

    const merged = await loadScopeBuildSecrets(encryptedEnv(fakeDb({})), fakeDb({}), ENV_SCOPE, {
      kind: "environment",
      repositories: [{ repoOwner: "acme", repoName: "web", baseBranch: "main" }],
      repositoriesFingerprint: "fp-env",
    });

    expect(secretsStores.environment).toHaveBeenCalledWith("env_1");
    expect(secretsStores.repo).not.toHaveBeenCalled();
    expect(merged).toEqual({ SHARED: "environment", GLOBAL_ONLY: "g" });
  });

  it("folds global + repo secrets for repo scopes, keyed by the target's repo id", async () => {
    secretsStores.global.mockResolvedValue({ SHARED: "global", GLOBAL_ONLY: "g" });
    secretsStores.repo.mockResolvedValue({ SHARED: "repo", REPO_ONLY: "r" });

    const merged = await loadScopeBuildSecrets(
      encryptedEnv(fakeDb({})),
      fakeDb({}),
      REPO_SCOPE,
      repoTarget()
    );

    expect(secretsStores.repo).toHaveBeenCalledWith(123);
    expect(secretsStores.environment).not.toHaveBeenCalled();
    expect(merged).toEqual({ SHARED: "repo", GLOBAL_ONLY: "g", REPO_ONLY: "r" });
  });

  it("still folds global secrets when repo secret decryption fails", async () => {
    secretsStores.global.mockResolvedValue({ GLOBAL_ONLY: "g" });
    secretsStores.repo.mockRejectedValue(new Error("decrypt failed"));

    const merged = await loadScopeBuildSecrets(
      encryptedEnv(fakeDb({})),
      fakeDb({}),
      REPO_SCOPE,
      repoTarget()
    );

    expect(merged).toEqual({ GLOBAL_ONLY: "g" });
  });

  it("returns undefined when the fold is empty", async () => {
    expect(
      await loadScopeBuildSecrets(encryptedEnv(fakeDb({})), fakeDb({}), REPO_SCOPE, repoTarget())
    ).toBe(undefined);
  });
});
