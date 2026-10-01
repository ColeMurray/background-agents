import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { EnvironmentSecretsStore } from "../../src/db/environment-secrets";
import { GlobalSecretsStore } from "../../src/db/global-secrets";
import { RepoSecretsStore } from "../../src/db/repo-secrets";
import { TeamSecretsStore } from "../../src/db/team-secrets";
import { loadScopeBuildSecrets } from "../../src/image-builds/scope";
import { createCloudflareEnv } from "../../src/cloudflare/platform";
import { cleanD1Tables } from "./cleanup";
import { initSession } from "./helpers";
import { getUserEnvVars } from "./session-do-access";

const TEAM_A = "team_a";
const TEAM_B = "team_b";
const ENV_ID = "env_team_secrets";
const key = () => env.REPO_SECRETS_ENCRYPTION_KEY!;

describe("team secret resolution", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    await env.DB.prepare(
      "INSERT INTO teams (id, slug, name, created_at, updated_at) VALUES (?, ?, ?, 1, 1), (?, ?, ?, 1, 1)"
    )
      .bind(TEAM_A, "a", "A", TEAM_B, "b", "B")
      .run();
    await env.DB.prepare(
      "INSERT INTO environments (id, name, owner_team_id, created_at, updated_at) VALUES (?, ?, ?, 1, 1)"
    )
      .bind(ENV_ID, "Team secrets environment", TEAM_A)
      .run();
    await new GlobalSecretsStore(env.DB, key()).setSecrets({
      SHARED: "global",
      GLOBAL_TEAM: "global",
      GLOBAL_ONLY: "global",
    });
    const teamStore = new TeamSecretsStore(env.DB, key());
    await teamStore.setSecrets(TEAM_A, {
      SHARED: "team-a",
      GLOBAL_TEAM: "team-a",
      TEAM_ONLY: "a",
      XAI_OAUTH_REFRESH_TOKEN: "team-a-refresh",
    });
    await teamStore.setSecrets(TEAM_B, { SHARED: "team-b", TEAM_B_ONLY: "b" });
    await new EnvironmentSecretsStore(env.DB, key()).setSecrets(ENV_ID, { SHARED: "environment" });
  });

  async function sessionEnv(teamId: string | null, environmentId: string | null = null) {
    const session = await initSession({ environmentId });
    await env.DB.prepare("UPDATE sessions SET owner_team_id = ? WHERE id = ?")
      .bind(teamId, session.sessionName)
      .run();
    return { ...session, vars: await getUserEnvVars(session.stub) };
  }

  it("gives environment precedence over team and global and retains team broker credentials", async () => {
    const { vars } = await sessionEnv(TEAM_A, ENV_ID);
    expect(vars).toEqual({
      SHARED: "environment",
      GLOBAL_TEAM: "team-a",
      GLOBAL_ONLY: "global",
      TEAM_ONLY: "a",
      XAI_OAUTH_MANAGED: "1",
    });
  });

  it("gives team precedence over global without letting member repositories change the broker", async () => {
    const { vars } = await sessionEnv(TEAM_A);
    expect(vars).toEqual({
      SHARED: "team-a",
      GLOBAL_TEAM: "team-a",
      GLOBAL_ONLY: "global",
      TEAM_ONLY: "a",
      XAI_OAUTH_MANAGED: "1",
    });
  });

  it("keeps primary repository precedence over team secrets", async () => {
    await new RepoSecretsStore(env.DB, key()).setSecrets(12345, "acme", "web-app", {
      SHARED: "repo",
    });
    const { vars } = await sessionEnv(TEAM_A);
    expect(vars?.SHARED).toBe("repo");
    expect(vars?.GLOBAL_TEAM).toBe("team-a");
  });

  it("never injects another team's secrets or any team secrets into workspace sessions", async () => {
    const { vars } = await sessionEnv(TEAM_B);
    expect(vars).toEqual({
      SHARED: "team-b",
      GLOBAL_TEAM: "global",
      GLOBAL_ONLY: "global",
      TEAM_B_ONLY: "b",
    });
    expect((await sessionEnv(null)).vars).toEqual({
      SHARED: "global",
      GLOBAL_TEAM: "global",
      GLOBAL_ONLY: "global",
    });
  });

  it("uses current D1 ownership after a session moves teams", async () => {
    const session = await sessionEnv(TEAM_A);
    await env.DB.prepare("UPDATE sessions SET owner_team_id = ? WHERE id = ?")
      .bind(TEAM_B, session.sessionName)
      .run();
    const vars = await getUserEnvVars(session.stub);
    expect(vars?.TEAM_ONLY).toBeUndefined();
    expect(vars?.XAI_OAUTH_MANAGED).toBeUndefined();
    expect(vars?.TEAM_B_ONLY).toBe("b");
  });

  it("adds the environment owner's team to builds but never to repository-shared builds", async () => {
    const appEnv = createCloudflareEnv(env);
    expect(
      await loadScopeBuildSecrets(
        appEnv,
        env.DB,
        { kind: "environment", id: ENV_ID },
        {
          kind: "environment",
          repositories: [],
          repositoriesFingerprint: "test-env",
        }
      )
    ).toEqual({
      SHARED: "environment",
      GLOBAL_TEAM: "team-a",
      GLOBAL_ONLY: "global",
      TEAM_ONLY: "a",
      XAI_OAUTH_REFRESH_TOKEN: "team-a-refresh",
    });
    await new RepoSecretsStore(env.DB, key()).setSecrets(12345, "acme", "web-app", {
      SHARED: "repo",
    });
    expect(
      await loadScopeBuildSecrets(
        appEnv,
        env.DB,
        { kind: "repo", id: "acme/web-app" },
        {
          kind: "repo",
          repoId: 12345,
          repositories: [],
          repositoriesFingerprint: "test-repo",
        }
      )
    ).toEqual({ SHARED: "repo", GLOBAL_TEAM: "global", GLOBAL_ONLY: "global" });
  });
});
