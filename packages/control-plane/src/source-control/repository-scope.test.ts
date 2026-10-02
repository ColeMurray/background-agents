import type { InstallationRepository } from "@open-inspect/shared/types/repository-catalog";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SqlDatabase } from "../db/sql-database";
import { TeamRepositoryGrantStore } from "../db/team-repository-grants";
import { MAX_CREDENTIAL_SCOPE_REPOSITORY_IDS } from "./credential-scope";
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

  it("sorts and deduplicates known ids without loading the catalog or grants", async () => {
    const repositories = [repository(30), repository(12, "acme", "api"), repository(30)];

    expect(await resolveRepositoryCredentialScope(db, repositories, null, loadCatalog)).toEqual({
      kind: "repositories",
      repositoryIds: [12, 30],
    });
    expect(loadCatalog).not.toHaveBeenCalled();
    expect(TeamRepositoryGrantStore.prototype.listForTeam).not.toHaveBeenCalled();
  });

  it("resolves NULL ids from the catalog by nested owner and name case-insensitively", async () => {
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

  it("refuses the entire scope if any NULL id is unresolved, ignoring catalog fullName", async () => {
    loadCatalog.mockResolvedValue([
      catalogRepository(12, "acme", "web"),
      { ...catalogRepository(99, "other", "missing"), fullName: "acme/missing" },
    ]);

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

  it.each([
    { source: "stored", repositories: [repository(0)], catalog: [] },
    {
      source: "catalog",
      repositories: [repository(null)],
      catalog: [catalogRepository(Number.NaN, "acme", "web")],
    },
  ])("refuses an invalid $source id before reading grants", async ({ repositories, catalog }) => {
    loadCatalog.mockResolvedValue(catalog);

    await expect(
      resolveRepositoryCredentialScope(db, repositories, "team-a", loadCatalog)
    ).rejects.toMatchObject({ errorType: "permanent" });
    expect(TeamRepositoryGrantStore.prototype.listForTeam).not.toHaveBeenCalled();
  });

  it("refuses an empty repository set without reading grants", async () => {
    await expect(
      resolveRepositoryCredentialScope(db, [], "team-a", loadCatalog)
    ).rejects.toMatchObject({ errorType: "permanent" });
    expect(TeamRepositoryGrantStore.prototype.listForTeam).not.toHaveBeenCalled();
  });

  it("filters candidates to the owning team's repository grants", async () => {
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
    expect(TeamRepositoryGrantStore.prototype.listForTeam).toHaveBeenCalledWith("team-a");
  });

  it("keeps all candidates, and only candidates, under an installation grant", async () => {
    vi.mocked(TeamRepositoryGrantStore.prototype.listForTeam).mockResolvedValue([
      { grant_kind: "installation", repo_external_id: null },
    ]);
    loadCatalog.mockResolvedValue([
      catalogRepository(12, "acme", "web"),
      catalogRepository(99, "other", "not-in-session"),
    ]);

    expect(
      await resolveRepositoryCredentialScope(
        db,
        [repository(null), repository(30, "acme", "api")],
        "team-a",
        loadCatalog
      )
    ).toEqual({ kind: "repositories", repositoryIds: [12, 30] });
  });

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
  });
});
