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

function indexSession(ownerTeamId: string | null): SessionEntry {
  return { id: SESSION_ID, ownerTeamId, environmentId: "source-environment" } as SessionEntry;
}

describe("resolveSessionCredentialScope", () => {
  beforeEach(() => {
    vi.spyOn(SessionIndexStore.prototype, "get").mockResolvedValue(indexSession(null));
    vi.spyOn(SessionRepositoryStore.prototype, "listRepositoryIds").mockResolvedValue([
      { repoOwner: "acme", repoName: "web", repoId: 12 },
    ]);
    vi.spyOn(TeamRepositoryGrantStore.prototype, "covers").mockResolvedValue(true);
    loadCatalog.mockReset().mockResolvedValue([]);
  });

  afterEach(() => vi.restoreAllMocks());

  it("fails closed with the permanent credential error when the session is missing", async () => {
    vi.mocked(SessionIndexStore.prototype.get).mockResolvedValue(null);

    const error = await resolveSessionCredentialScope(db, SESSION_ID, loadCatalog).catch(
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(SourceControlProviderError);
    expect(error).toMatchObject({
      message: "Cannot resolve credential scope: session not found",
      errorType: "permanent",
    });
    expect(SessionIndexStore.prototype.get).toHaveBeenCalledExactlyOnceWith(SESSION_ID);
    expect(SessionRepositoryStore.prototype.listRepositoryIds).not.toHaveBeenCalled();
    expect(TeamRepositoryGrantStore.prototype.covers).not.toHaveBeenCalled();
    expect(loadCatalog).not.toHaveBeenCalled();
  });

  it("limits workspace credentials to the session's own repository", async () => {
    expect(await resolveSessionCredentialScope(db, SESSION_ID, loadCatalog)).toEqual({
      kind: "repositories",
      repositoryIds: [12],
    });

    expect(SessionRepositoryStore.prototype.listRepositoryIds).toHaveBeenCalledExactlyOnceWith(
      SESSION_ID
    );
    expect(TeamRepositoryGrantStore.prototype.covers).not.toHaveBeenCalled();
    expect(loadCatalog).not.toHaveBeenCalled();
  });

  it("includes persisted session members instead of expanding the current environment", async () => {
    vi.mocked(SessionRepositoryStore.prototype.listRepositoryIds).mockResolvedValue([
      { repoOwner: "acme", repoName: "web", repoId: 30 },
      { repoOwner: "acme", repoName: "api", repoId: 12 },
    ]);

    expect(await resolveSessionCredentialScope(db, SESSION_ID, loadCatalog)).toEqual({
      kind: "repositories",
      repositoryIds: [12, 30],
    });

    expect(SessionRepositoryStore.prototype.listRepositoryIds).toHaveBeenCalledWith(SESSION_ID);
    expect(loadCatalog).not.toHaveBeenCalled();
  });

  it("does not expand a child's primary-only membership from environment provenance", async () => {
    vi.mocked(SessionIndexStore.prototype.get).mockResolvedValue({
      ...indexSession(null),
      parentSessionId: "parent-session",
    });

    expect(await resolveSessionCredentialScope(db, SESSION_ID, loadCatalog)).toEqual({
      kind: "repositories",
      repositoryIds: [12],
    });
  });

  it("resolves the legacy primary fallback through the lazy catalog callback", async () => {
    vi.mocked(SessionRepositoryStore.prototype.listRepositoryIds).mockResolvedValue([
      { repoOwner: "acme", repoName: "web", repoId: null },
    ]);
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
    expect(loadCatalog).toHaveBeenCalledTimes(1);
  });

  it("uses current team grants to drop revoked session repositories", async () => {
    vi.mocked(SessionIndexStore.prototype.get).mockResolvedValue(indexSession("team-a"));
    vi.mocked(SessionRepositoryStore.prototype.listRepositoryIds).mockResolvedValue([
      { repoOwner: "acme", repoName: "web", repoId: 12 },
      { repoOwner: "acme", repoName: "api", repoId: 30 },
    ]);
    vi.mocked(TeamRepositoryGrantStore.prototype.covers)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    expect(await resolveSessionCredentialScope(db, SESSION_ID, loadCatalog)).toEqual({
      kind: "repositories",
      repositoryIds: [12],
    });
    expect(TeamRepositoryGrantStore.prototype.covers).toHaveBeenNthCalledWith(
      1,
      "team-a",
      [12, 30]
    );
  });

  it("re-reads ownership and membership on every call", async () => {
    vi.mocked(SessionIndexStore.prototype.get)
      .mockResolvedValueOnce(indexSession("team-a"))
      .mockResolvedValueOnce(indexSession("team-b"))
      .mockResolvedValueOnce(indexSession(null));
    vi.mocked(SessionRepositoryStore.prototype.listRepositoryIds)
      .mockResolvedValueOnce([{ repoOwner: "acme", repoName: "web", repoId: 12 }])
      .mockResolvedValueOnce([{ repoOwner: "acme", repoName: "api", repoId: 30 }])
      .mockResolvedValueOnce([{ repoOwner: "acme", repoName: "cli", repoId: 50 }]);

    expect(await resolveSessionCredentialScope(db, SESSION_ID, loadCatalog)).toEqual({
      kind: "repositories",
      repositoryIds: [12],
    });
    expect(await resolveSessionCredentialScope(db, SESSION_ID, loadCatalog)).toEqual({
      kind: "repositories",
      repositoryIds: [30],
    });
    expect(await resolveSessionCredentialScope(db, SESSION_ID, loadCatalog)).toEqual({
      kind: "repositories",
      repositoryIds: [50],
    });

    expect(SessionIndexStore.prototype.get).toHaveBeenCalledTimes(3);
    expect(SessionRepositoryStore.prototype.listRepositoryIds).toHaveBeenCalledTimes(3);
    expect(TeamRepositoryGrantStore.prototype.covers).toHaveBeenCalledTimes(2);
    expect(TeamRepositoryGrantStore.prototype.covers).toHaveBeenNthCalledWith(1, "team-a", [12]);
    expect(TeamRepositoryGrantStore.prototype.covers).toHaveBeenNthCalledWith(2, "team-b", [30]);
  });

  it.each([
    { label: "no session repositories", repositories: [] },
    {
      label: "unresolved NULL repository id",
      repositories: [{ repoOwner: "acme", repoName: "web", repoId: null }],
    },
  ])("refuses $label without broadening credentials", async ({ repositories }) => {
    vi.mocked(SessionRepositoryStore.prototype.listRepositoryIds).mockResolvedValue(repositories);

    await expect(resolveSessionCredentialScope(db, SESSION_ID, loadCatalog)).rejects.toMatchObject({
      errorType: "permanent",
    });
    expect(TeamRepositoryGrantStore.prototype.covers).not.toHaveBeenCalled();
  });

  it("propagates session-store failures without reading membership", async () => {
    const error = new Error("Session store unavailable");
    vi.mocked(SessionIndexStore.prototype.get).mockRejectedValueOnce(error);

    await expect(resolveSessionCredentialScope(db, SESSION_ID, loadCatalog)).rejects.toBe(error);

    expect(SessionRepositoryStore.prototype.listRepositoryIds).not.toHaveBeenCalled();
    expect(loadCatalog).not.toHaveBeenCalled();
  });

  it("propagates membership-store failures without resolving a fallback scope", async () => {
    const error = new Error("Session membership unavailable");
    vi.mocked(SessionRepositoryStore.prototype.listRepositoryIds).mockRejectedValueOnce(error);

    await expect(resolveSessionCredentialScope(db, SESSION_ID, loadCatalog)).rejects.toBe(error);

    expect(TeamRepositoryGrantStore.prototype.covers).not.toHaveBeenCalled();
    expect(loadCatalog).not.toHaveBeenCalled();
  });

  it("propagates grant-store failures without broadening credentials", async () => {
    vi.mocked(SessionIndexStore.prototype.get).mockResolvedValue(indexSession("team-a"));
    const error = new Error("Grant store unavailable");
    vi.mocked(TeamRepositoryGrantStore.prototype.covers).mockRejectedValueOnce(error);

    await expect(resolveSessionCredentialScope(db, SESSION_ID, loadCatalog)).rejects.toBe(error);
  });
});
