import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnvironmentStore } from "../../src/db/environments";
import { EnvironmentSecretsStore } from "../../src/db/environment-secrets";
import { RepoSecretsStore } from "../../src/db/repo-secrets";
import { TeamStore } from "../../src/db/teams";
import { TeamRepositoryGrantStore } from "../../src/db/team-repository-grants";
import { GitHubSourceControlProvider } from "../../src/source-control/providers/github-provider";
import { cleanD1Tables } from "./cleanup";
import { routeRequest, serviceRequestHeaders } from "./helpers";

const ENVIRONMENT_ID = "env_import_identity";

async function importSecrets() {
  const url = `https://test.local/environments/${ENVIRONMENT_ID}/secrets/import`;
  const init = {
    method: "POST",
    body: JSON.stringify({ repoOwner: "acme", repoName: "web" }),
  };
  return routeRequest(
    new Request(url, { ...init, headers: await serviceRequestHeaders(url, init) }),
    env,
    createExecutionContext()
  );
}

async function seedImportEnvironment(repoId: number | null, grantedRepoId: number) {
  const team = await new TeamStore(env.DB).create({
    slug: "importers",
    name: "Importers",
    joinPolicy: "invite_only",
  });
  await new TeamRepositoryGrantStore(env.DB).add(team.id, {
    kind: "repository",
    repoExternalId: grantedRepoId,
    owner: "acme",
    name: "web",
  });
  const store = new EnvironmentStore(env.DB);
  await store.create(
    {
      id: ENVIRONMENT_ID,
      owner_team_id: team.id,
      name: "Import identity",
      description: null,
      prebuild_enabled: 0,
      channel_associations: null,
      created_at: 1,
      updated_at: 1,
    },
    [{ position: 0, repo_owner: "acme", repo_name: "web", repo_id: repoId, base_branch: "main" }]
  );
  const repoSecretsStore = new RepoSecretsStore(env.DB, env.REPO_SECRETS_ENCRYPTION_KEY!);
  await repoSecretsStore.setSecrets(123, "acme", "web", {
    OLD_SOURCE_KEY: "old-source-value",
  });
  const secretsStore = new EnvironmentSecretsStore(env.DB, env.REPO_SECRETS_ENCRYPTION_KEY!);
  await secretsStore.setSecrets(ENVIRONMENT_ID, { EXISTING_KEY: "existing-value" });
  return { store, repoSecretsStore, secretsStore };
}

describe("environment secret import repository identity", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    vi.spyOn(GitHubSourceControlProvider.prototype, "checkRepositoryAccess").mockResolvedValue({
      repoId: 456,
      repoOwner: "acme",
      repoName: "web",
      defaultBranch: "main",
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("rejects a stale member ID despite its old grant and encrypted source secrets", async () => {
    const { store, secretsStore } = await seedImportEnvironment(123, 123);
    const membersBefore = await store.getRepositoriesForEnvironment(ENVIRONMENT_ID);
    const keysBefore = await secretsStore.listSecretKeys(ENVIRONMENT_ID);
    const source = await env.DB.prepare(
      "SELECT key, encrypted_value FROM repo_secrets WHERE repo_id = ?"
    )
      .bind(123)
      .all<{ key: string; encrypted_value: string }>();
    expect(source.results).toHaveLength(1);
    const teamGrants = vi.spyOn(TeamRepositoryGrantStore.prototype, "listForTeam");
    const sourceGrants = vi.spyOn(TeamRepositoryGrantStore.prototype, "listTeamsForRepository");
    const importer = vi.spyOn(EnvironmentSecretsStore.prototype, "importFromRepo");

    const response = await importSecrets();

    expect(response.status).toBe(409);
    const raw = await response.clone().text();
    expect(await response.json()).toEqual({
      error: "Repository identity changed",
      code: "repository_identity_mismatch",
      repository: "acme/web",
    });
    expect(raw).not.toContain("old-source-value");
    for (const row of source.results) {
      expect(raw).not.toContain(row.key);
      expect(raw).not.toContain(row.encrypted_value);
    }
    expect(GitHubSourceControlProvider.prototype.checkRepositoryAccess).toHaveBeenCalledOnce();
    expect(GitHubSourceControlProvider.prototype.checkRepositoryAccess).toHaveBeenCalledWith({
      owner: "acme",
      name: "web",
    });
    expect(teamGrants).not.toHaveBeenCalled();
    expect(sourceGrants).not.toHaveBeenCalled();
    expect(importer).not.toHaveBeenCalled();
    expect(await secretsStore.listSecretKeys(ENVIRONMENT_ID)).toEqual(keysBefore);
    expect(await secretsStore.getDecryptedSecrets(ENVIRONMENT_ID)).toEqual({
      EXISTING_KEY: "existing-value",
    });
    expect(await store.getRepositoriesForEnvironment(ENVIRONMENT_ID)).toEqual(membersBefore);
  });

  it("imports only the current ID for a legacy null-ID member", async () => {
    const { store, repoSecretsStore, secretsStore } = await seedImportEnvironment(null, 456);
    const membersBefore = await store.getRepositoriesForEnvironment(ENVIRONMENT_ID);
    await repoSecretsStore.setSecrets(456, "acme", "web", {
      CURRENT_SOURCE_KEY: "current-source-value",
    });
    const source = await env.DB.prepare(
      "SELECT key, encrypted_value FROM repo_secrets WHERE repo_id = ?"
    )
      .bind(456)
      .all<{ key: string; encrypted_value: string }>();
    expect(source.results).toHaveLength(1);

    const response = await importSecrets();

    expect(response.status).toBe(200);
    const raw = await response.clone().text();
    expect(await response.json()).toEqual({
      status: "imported",
      environmentId: ENVIRONMENT_ID,
      source: "acme/web",
      keys: ["CURRENT_SOURCE_KEY"],
      created: 1,
      updated: 0,
    });
    expect(raw).not.toContain("OLD_SOURCE_KEY");
    expect(raw).not.toContain("old-source-value");
    expect(raw).not.toContain("current-source-value");
    for (const row of source.results) expect(raw).not.toContain(row.encrypted_value);
    expect(GitHubSourceControlProvider.prototype.checkRepositoryAccess).toHaveBeenCalledOnce();
    expect(await secretsStore.getDecryptedSecrets(ENVIRONMENT_ID)).toEqual({
      EXISTING_KEY: "existing-value",
      CURRENT_SOURCE_KEY: "current-source-value",
    });
    const copied = await env.DB.prepare(
      "SELECT key, encrypted_value FROM environment_secrets WHERE environment_id = ? AND key = ?"
    )
      .bind(ENVIRONMENT_ID, "CURRENT_SOURCE_KEY")
      .all<{ key: string; encrypted_value: string }>();
    expect(copied.results).toEqual(source.results);
    expect(await store.getRepositoriesForEnvironment(ENVIRONMENT_ID)).toEqual(membersBefore);
  });

  it("returns 404 without copying secrets when the member repository disappears", async () => {
    const { store, secretsStore } = await seedImportEnvironment(123, 123);
    const membersBefore = await store.getRepositoriesForEnvironment(ENVIRONMENT_ID);
    const keysBefore = await secretsStore.listSecretKeys(ENVIRONMENT_ID);
    vi.mocked(GitHubSourceControlProvider.prototype.checkRepositoryAccess).mockResolvedValue(null);

    const response = await importSecrets();

    expect(response.status).toBe(404);
    const raw = await response.text();
    expect(raw).not.toContain("OLD_SOURCE_KEY");
    expect(raw).not.toContain("old-source-value");
    expect(GitHubSourceControlProvider.prototype.checkRepositoryAccess).toHaveBeenCalledOnce();
    expect(await secretsStore.listSecretKeys(ENVIRONMENT_ID)).toEqual(keysBefore);
    expect(await secretsStore.getDecryptedSecrets(ENVIRONMENT_ID)).toEqual({
      EXISTING_KEY: "existing-value",
    });
    expect(await store.getRepositoriesForEnvironment(ENVIRONMENT_ID)).toEqual(membersBefore);
  });
});
