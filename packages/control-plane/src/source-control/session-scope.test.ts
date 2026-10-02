import type { InstallationRepository } from "@open-inspect/shared/types/repository-catalog";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionIndexStore, type SessionEntry } from "../db/session-index";
import { SessionRepositoryStore } from "../db/session-repositories";
import type { SqlDatabase } from "../db/sql-database";
import { TeamRepositoryGrantStore } from "../db/team-repository-grants";
import { SourceControlProviderError } from "./errors";
import { resolveSessionCredentialScope } from "./session-scope";

const db = {} as SqlDatabase;
const SESSION_ID = "public-session";
const loadCatalog = vi.fn<() => Promise<InstallationRepository[]>>();

function indexSession(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    id: SESSION_ID,
    ownerTeamId: null,
    repoOwner: null,
    repoName: null,
    ...overrides,
  } as SessionEntry;
}

describe("resolveSessionCredentialScope", () => {
  beforeEach(() => {
    vi.spyOn(SessionIndexStore.prototype, "get").mockResolvedValue(indexSession());
    vi.spyOn(SessionRepositoryStore.prototype, "listRepositoryIds").mockResolvedValue([
      { repoOwner: "acme", repoName: "web", repoId: 30 },
      { repoOwner: "acme", repoName: "api", repoId: 12 },
    ]);
    vi.spyOn(TeamRepositoryGrantStore.prototype, "listForTeam").mockResolvedValue([]);
    loadCatalog.mockReset().mockResolvedValue([]);
  });

  afterEach(() => vi.restoreAllMocks());

  it("fails closed without reading membership when the session is missing", async () => {
    vi.mocked(SessionIndexStore.prototype.get).mockResolvedValue(null);

    const error = await resolveSessionCredentialScope(db, SESSION_ID, loadCatalog).catch(
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(SourceControlProviderError);
    expect(error).toMatchObject({
      message: "Cannot resolve credential scope: session not found",
      errorType: "permanent",
    });
    expect(SessionRepositoryStore.prototype.listRepositoryIds).not.toHaveBeenCalled();
  });

  it("scopes credentials to the persisted session members", async () => {
    expect(await resolveSessionCredentialScope(db, SESSION_ID, loadCatalog)).toEqual({
      kind: "repositories",
      repositoryIds: [12, 30],
    });
    expect(SessionRepositoryStore.prototype.listRepositoryIds).toHaveBeenCalledWith(SESSION_ID);
  });

  it("falls back to the session's scalar repository via the catalog when there are no members", async () => {
    vi.mocked(SessionIndexStore.prototype.get).mockResolvedValue(
      indexSession({ repoOwner: "acme", repoName: "web" })
    );
    vi.mocked(SessionRepositoryStore.prototype.listRepositoryIds).mockResolvedValue([]);
    loadCatalog.mockResolvedValue([
      {
        id: 12,
        owner: "ACME",
        name: "Web",
        fullName: "ACME/Web",
        description: null,
        private: true,
        defaultBranch: "main",
        archived: false,
      },
    ]);

    expect(await resolveSessionCredentialScope(db, SESSION_ID, loadCatalog)).toEqual({
      kind: "repositories",
      repositoryIds: [12],
    });
  });

  it("refuses a session with neither members nor a scalar repository", async () => {
    vi.mocked(SessionRepositoryStore.prototype.listRepositoryIds).mockResolvedValue([]);

    await expect(resolveSessionCredentialScope(db, SESSION_ID, loadCatalog)).rejects.toMatchObject({
      errorType: "permanent",
    });
  });

  it("intersects members with the owning team's current grants", async () => {
    vi.mocked(SessionIndexStore.prototype.get).mockResolvedValue(
      indexSession({ ownerTeamId: "team-a" })
    );
    vi.mocked(TeamRepositoryGrantStore.prototype.listForTeam).mockResolvedValue([
      { grant_kind: "repository", repo_external_id: 12 },
    ]);

    expect(await resolveSessionCredentialScope(db, SESSION_ID, loadCatalog)).toEqual({
      kind: "repositories",
      repositoryIds: [12],
    });
    expect(TeamRepositoryGrantStore.prototype.listForTeam).toHaveBeenCalledWith("team-a");
  });
});
