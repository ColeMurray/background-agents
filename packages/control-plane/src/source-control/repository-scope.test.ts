import type { InstallationRepository } from "@open-inspect/shared/types/repository-catalog";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SqlDatabase } from "../db/sql-database";
import { TeamRepositoryGrantStore } from "../db/team-repository-grants";
import { MAX_CREDENTIAL_SCOPE_REPOSITORY_IDS } from "./credential-scope";
import { SourceControlProviderError } from "./errors";
import { resolveRepositoryCredentialScope } from "./repository-scope";

const db = {} as SqlDatabase;
const loadCatalog = vi.fn<() => Promise<InstallationRepository[]>>();

function repository(repoId: number | null, repoOwner = "acme", repoName = "web") {
  return { repoOwner, repoName, repoId };
}

function catalogRepository(id: number, owner: string, name: string): InstallationRepository {
  return {
    id,
    owner,
    name,
    fullName: `${owner}/${name}`,
    description: null,
    private: true,
    defaultBranch: "main",
    archived: false,
  };
}

describe("resolveRepositoryCredentialScope", () => {
  beforeEach(() => {
    vi.spyOn(TeamRepositoryGrantStore.prototype, "listForTeam").mockResolvedValue([]);
    loadCatalog.mockReset().mockResolvedValue([]);
  });

  afterEach(() => vi.restoreAllMocks());

  it("sorts and deduplicates workspace candidates without loading the catalog or grants", async () => {
    const repositories = [repository(30), repository(12, "acme", "api"), repository(30)];

    expect(await resolveRepositoryCredentialScope(db, repositories, null, loadCatalog)).toEqual({
      kind: "repositories",
      repositoryIds: [12, 30],
    });
    expect(repositories.map((entry) => entry.repoId)).toEqual([30, 12, 30]);
    expect(loadCatalog).not.toHaveBeenCalled();
    expect(TeamRepositoryGrantStore.prototype.listForTeam).not.toHaveBeenCalled();
  });

  it("loads the catalog once for NULL ids and matches structured nested owners case-insensitively", async () => {
    loadCatalog.mockResolvedValue([
      catalogRepository(12, "Group/Subgroup", "Web"),
      catalogRepository(30, "group/subgroup", "API"),
      catalogRepository(99, "other", "unrelated"),
    ]);

    expect(
      await resolveRepositoryCredentialScope(
        db,
        [
          repository(null, "GROUP/SUBGROUP", "web"),
          repository(null, "group/subgroup", "api"),
          repository(50, "acme", "known"),
        ],
        null,
        loadCatalog
      )
    ).toEqual({ kind: "repositories", repositoryIds: [12, 30, 50] });
    expect(loadCatalog).toHaveBeenCalledTimes(1);
  });

  it("matches owner and name rather than trusting the catalog fullName", async () => {
    loadCatalog.mockResolvedValue([
      { ...catalogRepository(99, "other", "web"), fullName: "acme/web" },
    ]);

    await expect(
      resolveRepositoryCredentialScope(db, [repository(null)], null, loadCatalog)
    ).rejects.toMatchObject({ errorType: "permanent" });
  });

  it("loads the catalog afresh on each resolution that needs a NULL id", async () => {
    loadCatalog
      .mockResolvedValueOnce([catalogRepository(12, "acme", "web")])
      .mockResolvedValueOnce([]);

    expect(
      await resolveRepositoryCredentialScope(db, [repository(null)], null, loadCatalog)
    ).toEqual({ kind: "repositories", repositoryIds: [12] });
    await expect(
      resolveRepositoryCredentialScope(db, [repository(null)], null, loadCatalog)
    ).rejects.toMatchObject({ errorType: "permanent" });
    expect(loadCatalog).toHaveBeenCalledTimes(2);
  });

  it("refuses the entire scope if even one NULL id cannot be resolved", async () => {
    loadCatalog.mockResolvedValue([catalogRepository(12, "acme", "web")]);

    await expect(
      resolveRepositoryCredentialScope(
        db,
        [repository(null), repository(null, "acme", "missing")],
        "team-a",
        loadCatalog
      )
    ).rejects.toMatchObject({ errorType: "permanent" });
    expect(TeamRepositoryGrantStore.prototype.listForTeam).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "refuses invalid stored id %s before checking grants or consulting the catalog",
    async (id) => {
      await expect(
        resolveRepositoryCredentialScope(db, [repository(id)], "team-a", loadCatalog)
      ).rejects.toMatchObject({ errorType: "permanent" });
      expect(loadCatalog).not.toHaveBeenCalled();
      expect(TeamRepositoryGrantStore.prototype.listForTeam).not.toHaveBeenCalled();
    }
  );

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "refuses invalid catalog id %s instead of producing a partial scope",
    async (id) => {
      loadCatalog.mockResolvedValue([catalogRepository(id, "acme", "web")]);

      await expect(
        resolveRepositoryCredentialScope(
          db,
          [repository(12, "acme", "api"), repository(null)],
          null,
          loadCatalog
        )
      ).rejects.toBeInstanceOf(SourceControlProviderError);
    }
  );

  it("uses one grant read when all candidate repositories are granted", async () => {
    vi.mocked(TeamRepositoryGrantStore.prototype.listForTeam).mockResolvedValue([
      { grant_kind: "repository", repo_external_id: 12 },
      { grant_kind: "repository", repo_external_id: 30 },
      { grant_kind: "repository", repo_external_id: 99 },
    ]);

    expect(
      await resolveRepositoryCredentialScope(
        db,
        [repository(12), repository(30, "acme", "api"), repository(12)],
        "team-a",
        loadCatalog
      )
    ).toEqual({ kind: "repositories", repositoryIds: [12, 30] });
    expect(TeamRepositoryGrantStore.prototype.listForTeam).toHaveBeenCalledExactlyOnceWith(
      "team-a"
    );
  });

  it("retains only candidates even when the team has an installation grant", async () => {
    vi.mocked(TeamRepositoryGrantStore.prototype.listForTeam).mockResolvedValue([
      { grant_kind: "installation", repo_external_id: null },
    ]);
    loadCatalog.mockResolvedValue([
      catalogRepository(12, "acme", "web"),
      catalogRepository(99, "other", "not-in-session"),
    ]);

    expect(
      await resolveRepositoryCredentialScope(db, [repository(null)], "team-a", loadCatalog)
    ).toEqual({ kind: "repositories", repositoryIds: [12] });
    expect(TeamRepositoryGrantStore.prototype.listForTeam).toHaveBeenCalledExactlyOnceWith(
      "team-a"
    );
  });

  it("filters candidates from one grant read and drops revoked grants", async () => {
    vi.mocked(TeamRepositoryGrantStore.prototype.listForTeam).mockResolvedValue([
      { grant_kind: "repository", repo_external_id: 12 },
      { grant_kind: "repository", repo_external_id: 99 },
    ]);

    expect(
      await resolveRepositoryCredentialScope(
        db,
        [repository(30), repository(12, "acme", "api")],
        "team-a",
        loadCatalog
      )
    ).toEqual({ kind: "repositories", repositoryIds: [12] });
    expect(TeamRepositoryGrantStore.prototype.listForTeam).toHaveBeenCalledExactlyOnceWith(
      "team-a"
    );
  });

  it("uses a single grant snapshot even if a later read would return different grants", async () => {
    vi.mocked(TeamRepositoryGrantStore.prototype.listForTeam)
      .mockResolvedValueOnce([{ grant_kind: "repository", repo_external_id: 12 }])
      .mockResolvedValue([{ grant_kind: "repository", repo_external_id: 30 }]);

    expect(
      await resolveRepositoryCredentialScope(
        db,
        [repository(12), repository(30, "acme", "api")],
        "team-a",
        loadCatalog
      )
    ).toEqual({ kind: "repositories", repositoryIds: [12] });
    expect(TeamRepositoryGrantStore.prototype.listForTeam).toHaveBeenCalledExactlyOnceWith(
      "team-a"
    );
  });

  it("reads current grants on repeated calls instead of caching coverage", async () => {
    vi.mocked(TeamRepositoryGrantStore.prototype.listForTeam)
      .mockResolvedValueOnce([{ grant_kind: "repository", repo_external_id: 12 }])
      .mockResolvedValue([]);

    expect(
      await resolveRepositoryCredentialScope(db, [repository(12)], "team-a", loadCatalog)
    ).toEqual({ kind: "repositories", repositoryIds: [12] });
    await expect(
      resolveRepositoryCredentialScope(db, [repository(12)], "team-a", loadCatalog)
    ).rejects.toMatchObject({ errorType: "permanent" });
    expect(TeamRepositoryGrantStore.prototype.listForTeam).toHaveBeenCalledTimes(2);
  });

  it("does not turn a single-repository session into a large team's entire grant set", async () => {
    vi.mocked(TeamRepositoryGrantStore.prototype.listForTeam).mockResolvedValue(
      Array.from({ length: MAX_CREDENTIAL_SCOPE_REPOSITORY_IDS + 100 }, (_, index) => ({
        grant_kind: "repository",
        repo_external_id: index + 1,
      }))
    );

    expect(
      await resolveRepositoryCredentialScope(db, [repository(12)], "team-a", loadCatalog)
    ).toEqual({ kind: "repositories", repositoryIds: [12] });
    expect(TeamRepositoryGrantStore.prototype.listForTeam).toHaveBeenCalledExactlyOnceWith(
      "team-a"
    );
  });

  it.each([null, "team-a"])("refuses no repositories for owner %s", async (ownerTeamId) => {
    await expect(
      resolveRepositoryCredentialScope(db, [], ownerTeamId, loadCatalog)
    ).rejects.toMatchObject({ errorType: "permanent" });
    expect(loadCatalog).not.toHaveBeenCalled();
    expect(TeamRepositoryGrantStore.prototype.listForTeam).not.toHaveBeenCalled();
  });

  it("accepts the maximum unique repository scope including duplicate candidates", async () => {
    const repositories = Array.from({ length: MAX_CREDENTIAL_SCOPE_REPOSITORY_IDS }, (_, index) =>
      repository(index + 1, "acme", `repo-${index}`)
    );

    expect(
      await resolveRepositoryCredentialScope(
        db,
        [...repositories, ...repositories],
        null,
        loadCatalog
      )
    ).toEqual({ kind: "repositories", repositoryIds: repositories.map((entry) => entry.repoId) });
  });

  it.each([null, "team-a"])(
    "refuses an oversized credential scope for owner %s without truncation",
    async (ownerTeamId) => {
      const repositories = Array.from(
        { length: MAX_CREDENTIAL_SCOPE_REPOSITORY_IDS + 1 },
        (_, index) => repository(index + 1, "acme", `repo-${index}`)
      );
      vi.mocked(TeamRepositoryGrantStore.prototype.listForTeam).mockResolvedValue([
        { grant_kind: "installation", repo_external_id: null },
      ]);

      await expect(
        resolveRepositoryCredentialScope(db, repositories, ownerTeamId, loadCatalog)
      ).rejects.toMatchObject({ errorType: "permanent" });
    }
  );

  it("applies the scope limit to granted candidates, not the pre-filter repository count", async () => {
    const repositories = Array.from(
      { length: MAX_CREDENTIAL_SCOPE_REPOSITORY_IDS + 1 },
      (_, index) => repository(index + 1, "acme", `repo-${index}`)
    );
    vi.mocked(TeamRepositoryGrantStore.prototype.listForTeam).mockResolvedValue([
      { grant_kind: "repository", repo_external_id: 12 },
    ]);

    expect(await resolveRepositoryCredentialScope(db, repositories, "team-a", loadCatalog)).toEqual(
      { kind: "repositories", repositoryIds: [12] }
    );
    expect(TeamRepositoryGrantStore.prototype.listForTeam).toHaveBeenCalledExactlyOnceWith(
      "team-a"
    );
  });

  it("propagates catalog failures without checking grants or falling back", async () => {
    const error = new Error("Repository catalog unavailable");
    loadCatalog.mockRejectedValue(error);

    await expect(
      resolveRepositoryCredentialScope(db, [repository(null)], "team-a", loadCatalog)
    ).rejects.toBe(error);
    expect(TeamRepositoryGrantStore.prototype.listForTeam).not.toHaveBeenCalled();
  });

  it("propagates grant-read failures without returning a partial scope", async () => {
    const error = new Error("Grant store unavailable");
    vi.mocked(TeamRepositoryGrantStore.prototype.listForTeam).mockRejectedValueOnce(error);

    await expect(
      resolveRepositoryCredentialScope(
        db,
        [repository(12), repository(30, "acme", "api")],
        "team-a",
        loadCatalog
      )
    ).rejects.toBe(error);
  });
});
