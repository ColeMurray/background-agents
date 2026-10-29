import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as tokenCrypto from "../../src/auth/crypto";
import { EnvironmentSecretsStore } from "../../src/db/environment-secrets";
import { EnvironmentStore, type EnvironmentRepositoryInsert } from "../../src/db/environments";
import { RepoSecretsStore } from "../../src/db/repo-secrets";
import * as routeShared from "../../src/routes/shared";
import { cleanD1Tables } from "./cleanup";
import { serviceRequestHeaders } from "./helpers";
import {
  seedEnvironment as seedOwnedEnvironment,
  ownershipRequest,
  seedGrant,
  seedTeam,
} from "./ownership-test-helpers";

const BASE = "https://test.local";
const WEB: EnvironmentRepositoryInsert = {
  position: 0,
  repo_owner: "acme/group",
  repo_name: "web",
  repo_id: 1,
  base_branch: "main",
};
const API = { ...WEB, position: 1, repo_name: "api", repo_id: 2 };
const SOURCE = { repoOwner: WEB.repo_owner, repoName: WEB.repo_name, keys: ["TOKEN", "NEW_TOKEN"] };
const store = new EnvironmentStore(env.DB);
const secrets = new EnvironmentSecretsStore(env.DB, env.REPO_SECRETS_ENCRYPTION_KEY!);
const resolvedRepo = {
  repoId: 1,
  repoOwner: WEB.repo_owner,
  repoName: WEB.repo_name,
  defaultBranch: "main",
};

async function seedEnvironment(ownerTeamId: string | null, repositories = [WEB]) {
  const id = await seedOwnedEnvironment(`env_${crypto.randomUUID()}`, ownerTeamId, repositories);
  await secrets.setSecrets(id, {
    TOKEN: "original-environment-token",
    KEEP: "keep-environment-token",
  });
  return id;
}

async function secretRows(id: string) {
  const rows = await env.DB.prepare(
    "SELECT * FROM environment_secrets WHERE environment_id = ? ORDER BY key"
  )
    .bind(id)
    .all();
  return rows.results;
}

function importSecrets(id: string) {
  return ownershipRequest(`/environments/${id}/secrets/import`, {
    method: "POST",
    body: JSON.stringify(SOURCE),
  });
}

async function expectMissingSourceGrant(id: string) {
  const before = await secretRows(id);
  const repositories = await store.getRepositoriesForEnvironment(id);
  const response = await importSecrets(id);
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    error: "Target team lacks repository grant",
    code: "target_team_missing_grant",
    repository: "acme/group/web",
  });
  expect(EnvironmentSecretsStore.prototype.importFromRepo).not.toHaveBeenCalled();
  expect(tokenCrypto.decryptToken).not.toHaveBeenCalled();
  expect(await secretRows(id)).toEqual(before);
  expect(await store.getRepositoriesForEnvironment(id)).toEqual(repositories);
}

function expectSourceResolvedOnce() {
  expect(routeShared.resolveRepoOrError).toHaveBeenCalledExactlyOnceWith(
    expect.anything(),
    WEB.repo_owner,
    WEB.repo_name,
    expect.anything(),
    expect.anything()
  );
}

async function expectSuccessfulImport(id: string) {
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
  expect(tokenCrypto.decryptToken).not.toHaveBeenCalled();
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
    vi.spyOn(routeShared, "resolveRepoOrError").mockResolvedValue(resolvedRepo);
  });
  afterEach(() => vi.restoreAllMocks());

  it.each(["repository", "installation"] as const)(
    "denies a revoked source %s grant even in a saved environment",
    async (kind) => {
      const teamId = await seedTeam(`team_revoked_${kind}`);
      await seedGrant(teamId, kind === "installation" ? kind : WEB);
      if (kind === "repository") await seedGrant(teamId, API);
      const id = await seedEnvironment(teamId, [WEB, API]);
      await env.DB.prepare(
        "DELETE FROM team_repository_grants WHERE team_id = ? AND grant_kind = ? AND (repo_external_id = ? OR grant_kind = 'installation')"
      )
        .bind(teamId, kind, WEB.repo_id)
        .run();
      await expectMissingSourceGrant(id);
      expectSourceResolvedOnce();
    }
  );

  it("does not authorize matching names with a different saved numeric grant", async () => {
    const teamId = await seedTeam("team_numeric_mismatch");
    await seedGrant(teamId, { ...WEB, repo_id: 99 });
    await expectMissingSourceGrant(await seedEnvironment(teamId));
    expectSourceResolvedOnce();
  });

  it.each(["repository", "installation"] as const)(
    "does not use another team's %s grant for a workspace owner",
    async (kind) => {
      const target = await seedTeam("team_target");
      const other = await seedTeam("team_other");
      await seedGrant(other, kind === "installation" ? kind : WEB);
      await expectMissingSourceGrant(await seedEnvironment(target));
    }
  );

  it("imports with only a numeric source grant despite stale names and ungranted secondary members", async () => {
    const teamId = await seedTeam("team_source_only");
    await seedGrant(teamId, { ...WEB, repo_owner: "previous-owner", repo_name: "previous-name" });
    const id = await seedEnvironment(teamId, [WEB, { ...API, repo_id: null }]);
    const before = await secretRows(id);
    const repositories = await store.getRepositoriesForEnvironment(id);
    await expectSuccessfulImport(id);
    expectSourceResolvedOnce();
    const copied = await secretRows(id);
    expect(copied.find((row) => row.key === "KEEP")).toEqual(
      before.find((row) => row.key === "KEEP")
    );
    // Import's no-decryption assertion above precedes this consumer read.
    expect(await secrets.getDecryptedSecrets(id)).toEqual({
      TOKEN: "source-token",
      NEW_TOKEN: "new-source-token",
      KEEP: "keep-environment-token",
    });
    expect(await store.getRepositoriesForEnvironment(id)).toEqual(repositories);
  });

  it.each([1, null])("allows an installation grant with saved source ID %s", async (repoId) => {
    const teamId = await seedTeam("team_installation");
    await seedGrant(teamId, "installation");
    await expectSuccessfulImport(await seedEnvironment(teamId, [{ ...WEB, repo_id: repoId }, API]));
    expectSourceResolvedOnce();
  });

  it("preserves workspace imports without any team grant", async () => {
    await expectSuccessfulImport(await seedEnvironment(null, [WEB, API]));
    expectSourceResolvedOnce();
  });

  it.each([1, 99])(
    "checks the freshly resolved numeric identity %s for a null saved source ID",
    async (resolvedId) => {
      const teamId = await seedTeam("team_resolve_null");
      await seedGrant(teamId, WEB);
      const id = await seedEnvironment(teamId, [{ ...WEB, repo_id: null }, API]);
      vi.mocked(routeShared.resolveRepoOrError).mockResolvedValue({
        ...resolvedRepo,
        repoId: resolvedId,
      });
      if (resolvedId === WEB.repo_id) await expectSuccessfulImport(id);
      else await expectMissingSourceGrant(id);
      expectSourceResolvedOnce();
      expect((await store.getRepositoriesForEnvironment(id))[0].repo_id).toBeNull();
    }
  );

  it.each([404, 500])(
    "fails closed on null-ID resolution failure %s despite matching grant names",
    async (status) => {
      const teamId = await seedTeam("team_unresolved");
      await seedGrant(teamId, WEB);
      const id = await seedEnvironment(teamId, [{ ...WEB, repo_id: null }]);
      const before = await secretRows(id);
      vi.mocked(routeShared.resolveRepoOrError).mockRejectedValue(
        new routeShared.HttpError("Resolution failed", status)
      );
      expect((await importSecrets(id)).status).toBe(status);
      expect(routeShared.resolveRepoOrError).toHaveBeenCalledTimes(1);
      expect(EnvironmentSecretsStore.prototype.importFromRepo).not.toHaveBeenCalled();
      expect(tokenCrypto.decryptToken).not.toHaveBeenCalled();
      expect(await secretRows(id)).toEqual(before);
      expect(await store.getRepositoriesForEnvironment(id)).toMatchObject([
        { ...WEB, repo_id: null },
      ]);
    }
  );
});
