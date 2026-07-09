import { describe, it, expect, beforeEach } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import type { SessionDO } from "../../src/session/durable-object";
import { GlobalSecretsStore } from "../../src/db/global-secrets";
import { RepoSecretsStore } from "../../src/db/repo-secrets";
import { cleanD1Tables } from "./cleanup";
import { initSession } from "./helpers";

const KEY = () => env.REPO_SECRETS_ENCRYPTION_KEY as string;

/** Invoke the DO's real (private) getUserEnvVars, exercising the session-target fold. */
function getUserEnvVars(stub: DurableObjectStub): Promise<Record<string, string> | undefined> {
  return runInDurableObject(stub, (instance: SessionDO) =>
    (
      instance as unknown as {
        getUserEnvVars(): Promise<Record<string, string> | undefined>;
      }
    ).getUserEnvVars()
  );
}

describe("getUserEnvVars session-target fold", () => {
  beforeEach(cleanD1Tables);

  it("folds member repo secrets with the primary winning collisions (ad-hoc list)", async () => {
    await new GlobalSecretsStore(env.DB, KEY()).setSecrets({ SHARED: "global", ONLY_GLOBAL: "g" });
    await new RepoSecretsStore(env.DB, KEY()).setSecrets(90101, "acme", "web", {
      SHARED: "web",
      ONLY_WEB: "w",
    });
    await new RepoSecretsStore(env.DB, KEY()).setSecrets(90102, "acme", "backend", {
      SHARED: "backend",
      ONLY_BACKEND: "b",
    });

    const { stub } = await initSession({
      repoOwner: "acme",
      repoName: "web",
      repoId: 90101,
      repositories: [
        { repoOwner: "acme", repoName: "web", repoId: 90101, baseBranch: "main" },
        { repoOwner: "acme", repoName: "backend", repoId: 90102, baseBranch: "main" },
      ],
    });

    const envVars = await getUserEnvVars(stub);

    // Primary (position 0 = acme/web) merges last and wins SHARED; every layer contributes.
    expect(envVars).toMatchObject({
      SHARED: "web",
      ONLY_GLOBAL: "g",
      ONLY_WEB: "w",
      ONLY_BACKEND: "b",
    });
  });

  it("merges global with the sole repo for a scalar session (single-repo parity)", async () => {
    await new GlobalSecretsStore(env.DB, KEY()).setSecrets({ SHARED: "global", ONLY_GLOBAL: "g" });
    await new RepoSecretsStore(env.DB, KEY()).setSecrets(90201, "acme", "solo", {
      SHARED: "repo",
      ONLY_REPO: "r",
    });

    const { stub } = await initSession({ repoOwner: "acme", repoName: "solo", repoId: 90201 });

    const envVars = await getUserEnvVars(stub);

    expect(envVars).toMatchObject({ SHARED: "repo", ONLY_GLOBAL: "g", ONLY_REPO: "r" });
  });
});
