import { describe, expect, it } from "vitest";
import type { Env } from "../types";
import { ImageBuildPlanningError, ImageBuildScopeNotFoundError } from "./errors";
import { computeRepositoriesFingerprint } from "./fingerprint";
import type { ImageBuildScope } from "./model";
import {
  ImageBuildScopeUnsupportedError,
  loadScopeBuildSecrets,
  resolveScopeEnabled,
  resolveScopeSandboxSettings,
  resolveScopeTarget,
} from "./scope";

const REPO_SCOPE: ImageBuildScope = { kind: "repo", id: "acme/web" };
const ENV_SCOPE: ImageBuildScope = { kind: "environment", id: "env_1" };

/**
 * Scripted D1 double for the two EnvironmentStore reads the environment arm
 * makes (environments by id, environment_repositories by environment id).
 */
function fakeDb(tables: {
  environment?: Record<string, unknown> | null;
  repositories?: Record<string, unknown>[];
}): D1Database {
  const statement = (sql: string) => ({
    bind: () => statement(sql),
    first: async () => {
      if (sql.includes("FROM environments")) return tables.environment ?? null;
      throw new Error(`unexpected first(): ${sql}`);
    },
    all: async () => {
      if (sql.includes("FROM environment_repositories")) {
        return { results: tables.repositories ?? [] };
      }
      if (sql.includes("FROM environments")) {
        return { results: tables.environment ? [tables.environment] : [] };
      }
      throw new Error(`unexpected all(): ${sql}`);
    },
  });
  return { prepare: statement } as unknown as D1Database;
}

function envWith(db: D1Database): Env {
  return { DB: db } as Env;
}

describe("resolveScopeTarget", () => {
  it("resolves an environment's repositories in position order with their fingerprint", async () => {
    const db = fakeDb({
      environment: { id: "env_1", prebuild_enabled: 1 },
      repositories: [
        { position: 0, repo_owner: "acme", repo_name: "web", base_branch: "main" },
        { position: 1, repo_owner: "acme", repo_name: "api", base_branch: "develop" },
      ],
    });

    const target = await resolveScopeTarget(envWith(db), ENV_SCOPE);

    expect(target.repositories).toEqual([
      { repoOwner: "acme", repoName: "web", baseBranch: "main" },
      { repoOwner: "acme", repoName: "api", baseBranch: "develop" },
    ]);
    expect(target.repositoriesFingerprint).toBe(
      await computeRepositoriesFingerprint(target.repositories)
    );
  });

  it("throws scope-not-found for a missing environment", async () => {
    const db = fakeDb({ environment: null });

    await expect(resolveScopeTarget(envWith(db), ENV_SCOPE)).rejects.toBeInstanceOf(
      ImageBuildScopeNotFoundError
    );
  });

  it("fails planning on an environment without repositories", async () => {
    const db = fakeDb({ environment: { id: "env_1" }, repositories: [] });

    await expect(resolveScopeTarget(envWith(db), ENV_SCOPE)).rejects.toBeInstanceOf(
      ImageBuildPlanningError
    );
  });

  it("rejects the repo scope kind until its arm lands", async () => {
    await expect(resolveScopeTarget(envWith(fakeDb({})), REPO_SCOPE)).rejects.toBeInstanceOf(
      ImageBuildScopeUnsupportedError
    );
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

  it("rejects the repo scope kind until its arm lands", async () => {
    await expect(resolveScopeEnabled(fakeDb({}), REPO_SCOPE)).rejects.toBeInstanceOf(
      ImageBuildScopeUnsupportedError
    );
  });
});

describe("repo arm of the remaining resolvers", () => {
  it("resolveScopeSandboxSettings rejects the repo scope kind", async () => {
    await expect(
      resolveScopeSandboxSettings(fakeDb({}), REPO_SCOPE, {
        repoOwner: "acme",
        repoName: "web",
        baseBranch: "main",
      })
    ).rejects.toBeInstanceOf(ImageBuildScopeUnsupportedError);
  });

  it("loadScopeBuildSecrets rejects the repo scope kind", async () => {
    await expect(loadScopeBuildSecrets(envWith(fakeDb({})), REPO_SCOPE)).rejects.toBeInstanceOf(
      ImageBuildScopeUnsupportedError
    );
  });
});
