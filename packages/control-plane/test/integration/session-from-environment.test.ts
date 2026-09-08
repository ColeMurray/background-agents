/**
 * Sessions launched from an environment (PR-9, design §7.6): the environment's
 * repositories are snapshotted into session_repositories and sessions.environment_id
 * records provenance. Secrets come from global + environment only — never the
 * member repos' — and editing/deleting the environment afterwards never mutates
 * the session (its name simply resolves null once deleted).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import type { SessionState } from "@open-inspect/shared";
import type { SessionDO } from "../../src/session/durable-object";
import { EnvironmentStore } from "../../src/db/environments";
import { EnvironmentSecretsStore } from "../../src/db/environment-secrets";
import { GlobalSecretsStore } from "../../src/db/global-secrets";
import { RepoSecretsStore } from "../../src/db/repo-secrets";
import { resolveEnvironmentTarget } from "../../src/repos/resolve";
import { cleanD1Tables } from "./cleanup";
import { initSession, queryDO } from "./helpers";

const KEY = () => env.REPO_SECRETS_ENCRYPTION_KEY as string;

interface RepoSpec {
  repoOwner: string;
  repoName: string;
  repoId: number;
  baseBranch: string;
}

async function seedEnvironment(id: string, name: string, repos: RepoSpec[]): Promise<void> {
  const now = Date.now();
  await new EnvironmentStore(env.DB).create(
    {
      id,
      name,
      description: null,
      prebuild_enabled: 0,
      channel_associations: null,
      created_at: now,
      updated_at: now,
    },
    repos.map((repo, position) => ({
      position,
      repo_owner: repo.repoOwner,
      repo_name: repo.repoName,
      repo_id: repo.repoId,
      base_branch: repo.baseBranch,
    }))
  );
}

/** Invoke the DO's real (private) getUserEnvVars, exercising the session secret fold. */
function getUserEnvVars(stub: DurableObjectStub): Promise<Record<string, string> | undefined> {
  return runInDurableObject(stub, (instance: SessionDO) =>
    (
      instance as unknown as {
        getUserEnvVars(): Promise<Record<string, string> | undefined>;
      }
    ).getUserEnvVars()
  );
}

/** Invoke the DO's real (private) getSessionState. */
function getSessionState(stub: DurableObjectStub): Promise<SessionState> {
  return runInDurableObject(stub, (instance: SessionDO) =>
    (instance as unknown as { getSessionState(): Promise<SessionState> }).getSessionState()
  );
}

const WEB: RepoSpec = { repoOwner: "acme", repoName: "web", repoId: 1, baseBranch: "main" };
const API: RepoSpec = { repoOwner: "acme", repoName: "api", repoId: 2, baseBranch: "develop" };

describe("sessions from environments", () => {
  beforeEach(cleanD1Tables);

  describe("resolveEnvironmentTarget", () => {
    it("returns the environment's members as resolution inputs in position order", async () => {
      await seedEnvironment("env_fs", "Full Stack", [WEB, API]);

      const inputs = await resolveEnvironmentTarget(new EnvironmentStore(env.DB), "env_fs");

      expect(inputs).toEqual([
        { repoOwner: "acme", repoName: "web", baseBranch: "main" },
        { repoOwner: "acme", repoName: "api", baseBranch: "develop" },
      ]);
    });

    it("raises 404 for a missing environment", async () => {
      await expect(
        resolveEnvironmentTarget(new EnvironmentStore(env.DB), "env_missing")
      ).rejects.toMatchObject({
        status: 404,
      });
    });
  });

  it("snapshots environment members and records provenance on the session", async () => {
    await seedEnvironment("env_fs", "Full Stack", [WEB, API]);

    const { stub } = await initSession({
      environmentId: "env_fs",
      repoOwner: WEB.repoOwner,
      repoName: WEB.repoName,
      repoId: WEB.repoId,
      repositories: [WEB, API],
    });

    const [session] = await queryDO<{ environment_id: string | null }>(
      stub,
      "SELECT environment_id FROM session"
    );
    expect(session.environment_id).toBe("env_fs");

    const members = await queryDO<{ repo_name: string }>(
      stub,
      "SELECT repo_name FROM session_repositories ORDER BY position"
    );
    expect(members.map((m) => m.repo_name)).toEqual(["web", "api"]);
  });

  it("exposes environmentId in state and resolves environmentName live", async () => {
    await seedEnvironment("env_fs", "Full Stack", [WEB]);

    const { stub } = await initSession({
      environmentId: "env_fs",
      repoOwner: WEB.repoOwner,
      repoName: WEB.repoName,
      repoId: WEB.repoId,
      repositories: [WEB],
    });

    const state = await getSessionState(stub);
    expect(state.environmentId).toBe("env_fs");
    expect(state.environmentName).toBe("Full Stack");
  });

  it("leaves the session snapshot intact when the environment is deleted (name resolves null)", async () => {
    await seedEnvironment("env_fs", "Full Stack", [WEB]);

    const { stub } = await initSession({
      environmentId: "env_fs",
      repoOwner: WEB.repoOwner,
      repoName: WEB.repoName,
      repoId: WEB.repoId,
      repositories: [WEB],
    });

    expect(await new EnvironmentStore(env.DB).delete("env_fs")).toBe(true);

    const state = await getSessionState(stub);
    // Provenance id survives; the name can no longer be resolved.
    expect(state.environmentId).toBe("env_fs");
    expect(state.environmentName).toBeNull();
    // The snapshotted member list is untouched by the deletion.
    const members = await queryDO<{ repo_name: string }>(
      stub,
      "SELECT repo_name FROM session_repositories"
    );
    expect(members.map((m) => m.repo_name)).toEqual(["web"]);
  });

  it("sources global + environment secrets only — member repo secrets never inherit", async () => {
    await seedEnvironment("env_fs", "Full Stack", [WEB]);
    await new GlobalSecretsStore(env.DB, KEY()).setSecrets({ SHARED: "global", ONLY_GLOBAL: "g" });
    await new EnvironmentSecretsStore(env.DB, KEY()).setSecrets("env_fs", {
      SHARED: "env",
      ONLY_ENV: "e",
    });
    // The member repo has its own secrets that must NOT leak into an
    // environment-launched session (§6.4/§7.4).
    await new RepoSecretsStore(env.DB, KEY()).setSecrets(WEB.repoId, "acme", "web", {
      SHARED: "web",
      ONLY_WEB: "w",
    });

    const { stub } = await initSession({
      environmentId: "env_fs",
      repoOwner: WEB.repoOwner,
      repoName: WEB.repoName,
      repoId: WEB.repoId,
      repositories: [WEB],
    });

    const envVars = await getUserEnvVars(stub);

    // Environment wins collisions over global; the member repo secret is absent.
    expect(envVars).toMatchObject({ SHARED: "env", ONLY_GLOBAL: "g", ONLY_ENV: "e" });
    expect(envVars).not.toHaveProperty("ONLY_WEB");
  });
});
