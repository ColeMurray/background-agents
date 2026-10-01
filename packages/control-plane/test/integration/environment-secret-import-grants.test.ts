import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as tokenCrypto from "../../src/auth/crypto";
import { EnvironmentSecretsStore } from "../../src/db/environment-secrets";
import { EnvironmentStore, type EnvironmentRepositoryInsert } from "../../src/db/environments";
import { RepoSecretsStore } from "../../src/db/repo-secrets";
import { TeamRepositoryGrantStore } from "../../src/db/team-repository-grants";
import { TeamStore } from "../../src/db/teams";
import * as routeShared from "../../src/routes/shared";
import { cleanD1Tables } from "./cleanup";
import { routeRequest, serviceRequestHeaders } from "./helpers";

const BASE = "https://test.local";
const WEB: EnvironmentRepositoryInsert = {
  position: 0,
  repo_owner: "acme/group",
  repo_name: "web",
  repo_id: 1,
  base_branch: "main",
};
const API: EnvironmentRepositoryInsert = { ...WEB, position: 1, repo_name: "api", repo_id: 2 };
const SOURCE = { repoOwner: WEB.repo_owner, repoName: WEB.repo_name, keys: ["TOKEN", "NEW_TOKEN"] };

async function team(slug: string) {
  return new TeamStore(env.DB).create({ slug, name: slug, joinPolicy: "invite_only" });
}

async function grant(teamId: string, kind: "repository" | "installation", repo = WEB) {
  await env.DB.prepare(
    `INSERT INTO team_repository_grants
       (id, team_id, grant_kind, repo_external_id, repo_owner, repo_name, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      crypto.randomUUID(),
      teamId,
      kind,
      kind === "repository" ? repo.repo_id : null,
      kind === "repository" ? repo.repo_owner : null,
      kind === "repository" ? repo.repo_name : null,
      Date.now()
    )
    .run();
}

async function seedEnvironment(ownerTeamId: string | null, repositories = [WEB]) {
  const id = `env_${crypto.randomUUID()}`;
  const now = Date.now();
  await new EnvironmentStore(env.DB).create(
    {
      id,
      owner_team_id: ownerTeamId,
      name: id,
      description: null,
      prebuild_enabled: 0,
      channel_associations: null,
      created_at: now,
      updated_at: now,
    },
    repositories
  );
  await new EnvironmentSecretsStore(env.DB, env.REPO_SECRETS_ENCRYPTION_KEY!).setSecrets(id, {
    TOKEN: "original-environment-token",
    KEEP: "keep-environment-token",
  });
  return id;
}

async function secretRows(id: string) {
  const rows = await env.DB.prepare(
    "SELECT key, encrypted_value, created_at, updated_at FROM environment_secrets WHERE environment_id = ? ORDER BY key"
  )
    .bind(id)
    .all<{ key: string; encrypted_value: string; created_at: number; updated_at: number }>();
  return rows.results;
}

async function importSecrets(id: string) {
  const url = `${BASE}/environments/${id}/secrets/import`;
  const init = { method: "POST", body: JSON.stringify(SOURCE) };
  return routeRequest(
    new Request(url, { ...init, headers: await serviceRequestHeaders(url, init) }),
    env,
    createExecutionContext()
  );
}

async function expectMissingSourceGrant(id: string) {
  const before = await secretRows(id);
  const repositories = await new EnvironmentStore(env.DB).getRepositoriesForEnvironment(id);
  const response = await importSecrets(id);

  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    code: "target_team_missing_grant",
    reason_code: "target_team_missing_grant",
    repository: "acme/group/web",
  });
  expect(EnvironmentSecretsStore.prototype.importFromRepo).not.toHaveBeenCalled();
  expect(tokenCrypto.decryptToken).not.toHaveBeenCalled();
  expect(await secretRows(id)).toEqual(before);
  expect(await new EnvironmentStore(env.DB).getRepositoriesForEnvironment(id)).toEqual(
    repositories
  );
}

async function expectSuccessfulImport(id: string) {
  const before = await secretRows(id);
  const repositories = await new EnvironmentStore(env.DB).getRepositoriesForEnvironment(id);
  const source = await env.DB.prepare(
    "SELECT key, encrypted_value FROM repo_secrets WHERE repo_id = ? ORDER BY key"
  )
    .bind(WEB.repo_id)
    .all<{ key: string; encrypted_value: string }>();
  const response = await importSecrets(id);

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    status: "imported",
    environmentId: id,
    source: "acme/group/web",
    keys: expect.arrayContaining(SOURCE.keys),
    created: 1,
    updated: 1,
  });
  expect(EnvironmentSecretsStore.prototype.importFromRepo).toHaveBeenCalledWith(
    id,
    WEB.repo_id,
    SOURCE.keys
  );
  expect(tokenCrypto.decryptToken).not.toHaveBeenCalled();
  const copied = await secretRows(id);
  expect(copied).toHaveLength(3);
  expect(copied.find((row) => row.key === "KEEP")).toEqual(
    before.find((row) => row.key === "KEEP")
  );
  for (const row of source.results) {
    expect(copied.find((secret) => secret.key === row.key)?.encrypted_value).toBe(
      row.encrypted_value
    );
  }
  expect(await new EnvironmentStore(env.DB).getRepositoriesForEnvironment(id)).toEqual(
    repositories
  );
}

describe("environment secret import team grants", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    await serviceRequestHeaders(`${BASE}/me/authorization`);
    await new RepoSecretsStore(env.DB, env.REPO_SECRETS_ENCRYPTION_KEY!).setSecrets(
      WEB.repo_id!,
      WEB.repo_owner,
      WEB.repo_name,
      { TOKEN: "source-token", NEW_TOKEN: "new-source-token" }
    );
    vi.spyOn(EnvironmentSecretsStore.prototype, "importFromRepo");
    vi.spyOn(tokenCrypto, "decryptToken");
    vi.spyOn(routeShared, "resolveRepoOrError").mockResolvedValue({
      repoId: WEB.repo_id!,
      repoOwner: WEB.repo_owner,
      repoName: WEB.repo_name,
      defaultBranch: "main",
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it.each(["repository", "installation"] as const)(
    "denies import after revoking the source's %s grant from a saved environment",
    async (kind) => {
      const target = await team(`revoked-${kind}`);
      await grant(target.id, kind);
      if (kind === "repository") await grant(target.id, "repository", API);
      const id = await seedEnvironment(target.id, [WEB, API]);
      await env.DB.prepare(
        "DELETE FROM team_repository_grants WHERE team_id = ? AND grant_kind = ? AND (repo_external_id = ? OR grant_kind = 'installation')"
      )
        .bind(target.id, kind, WEB.repo_id)
        .run();

      await expectMissingSourceGrant(id);
      expect(routeShared.resolveRepoOrError).not.toHaveBeenCalled();
    }
  );

  it("does not authorize matching repository names with a different numeric grant", async () => {
    const target = await team("numeric-mismatch");
    await grant(target.id, "repository", { ...WEB, repo_id: 99 });
    const id = await seedEnvironment(target.id);

    await expectMissingSourceGrant(id);
    expect(routeShared.resolveRepoOrError).not.toHaveBeenCalled();
  });

  it.each(["repository", "installation"] as const)(
    "does not use another team's %s grant, even for a workspace owner",
    async (kind) => {
      const target = await team(`target-${kind}`);
      const other = await team(`other-${kind}`);
      await grant(other.id, kind);
      const id = await seedEnvironment(target.id);

      await expectMissingSourceGrant(id);
    }
  );

  it("imports with only the source numeric grant without requiring other member grants or matching grant names", async () => {
    const target = await team("source-only");
    await grant(target.id, "repository", {
      ...WEB,
      repo_owner: "previous-owner",
      repo_name: "previous-name",
    });
    const id = await seedEnvironment(target.id, [WEB, { ...API, repo_id: null }]);

    await expectSuccessfulImport(id);
    expect(routeShared.resolveRepoOrError).not.toHaveBeenCalled();
  });

  it.each([1, null])(
    "allows an installation grant for a source with saved numeric ID %s",
    async (repoId) => {
      const target = await team("installation");
      await grant(target.id, "installation");
      const id = await seedEnvironment(target.id, [{ ...WEB, repo_id: repoId }, API]);

      await expectSuccessfulImport(id);
      if (repoId === null) {
        expect(routeShared.resolveRepoOrError).toHaveBeenCalledTimes(1);
      } else {
        expect(routeShared.resolveRepoOrError).not.toHaveBeenCalled();
      }
    }
  );

  it("preserves workspace-owned imports without any team repository grant", async () => {
    const id = await seedEnvironment(null, [WEB, API]);

    await expectSuccessfulImport(id);
    expect(routeShared.resolveRepoOrError).not.toHaveBeenCalled();
  });

  it.each([1, 99])(
    "resolves a directly seeded null source ID to %s before checking its numeric team grant",
    async (resolvedId) => {
      const target = await team("resolve-null");
      await grant(target.id, "repository");
      const id = await seedEnvironment(target.id, [{ ...WEB, repo_id: null }, API]);
      vi.mocked(routeShared.resolveRepoOrError).mockResolvedValue({
        repoId: resolvedId,
        repoOwner: WEB.repo_owner,
        repoName: WEB.repo_name,
        defaultBranch: "main",
      });
      const covers = vi.spyOn(TeamRepositoryGrantStore.prototype, "covers");

      if (resolvedId === WEB.repo_id) {
        await expectSuccessfulImport(id);
      } else {
        await expectMissingSourceGrant(id);
      }
      expect(routeShared.resolveRepoOrError).toHaveBeenCalledExactlyOnceWith(
        expect.anything(),
        WEB.repo_owner,
        WEB.repo_name,
        expect.anything(),
        expect.anything()
      );
      expect(covers).toHaveBeenCalledWith(target.id, [resolvedId]);
      expect(vi.mocked(routeShared.resolveRepoOrError).mock.invocationCallOrder[0]).toBeLessThan(
        covers.mock.invocationCallOrder[0]
      );
    }
  );

  it.each([404, 500])(
    "fails closed when a null source ID cannot resolve with status %s despite matching grant names",
    async (status) => {
      const target = await team("unresolved-source");
      await grant(target.id, "repository");
      const id = await seedEnvironment(target.id, [{ ...WEB, repo_id: null }]);
      const before = await secretRows(id);
      vi.mocked(routeShared.resolveRepoOrError).mockRejectedValue(
        new routeShared.HttpError("Source repository resolution failed", status)
      );
      const covers = vi.spyOn(TeamRepositoryGrantStore.prototype, "covers");

      const response = await importSecrets(id);

      expect(response.status).toBe(status);
      expect(routeShared.resolveRepoOrError).toHaveBeenCalledTimes(1);
      expect(covers).not.toHaveBeenCalled();
      expect(EnvironmentSecretsStore.prototype.importFromRepo).not.toHaveBeenCalled();
      expect(tokenCrypto.decryptToken).not.toHaveBeenCalled();
      expect(await secretRows(id)).toEqual(before);
      expect(await new EnvironmentStore(env.DB).getRepositoriesForEnvironment(id)).toMatchObject([
        { ...WEB, repo_id: null },
      ]);
    }
  );
});
