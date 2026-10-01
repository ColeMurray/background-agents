import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionIndexStore, type SessionEntry } from "../db/session-index";
import { SessionRepositoryStore } from "../db/session-repositories";
import { TeamRepositoryGrantStore } from "../db/team-repository-grants";
import { createNodeSqlDatabase } from "../node/sqlite-database";
import { createNodeSqlStorage } from "../node/sqlite-storage";
import { loadInstallationRepositories } from "../repos/cache";
import type { CredentialScope, SourceControlProvider } from "../source-control";
import type { Env } from "../types";
import { createSessionRuntime } from "./components";
import { buildSessionInternalRequest, SessionInternalPaths } from "./contracts";
import { initSchema } from "./schema";

vi.mock("../repos/cache", () => ({ loadInstallationRepositories: vi.fn() }));

function indexSession(ownerTeamId: string | null): SessionEntry {
  return { id: "public-session", ownerTeamId } as SessionEntry;
}

describe("session credential scope composition", () => {
  let sqlite: DatabaseSync;

  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    vi.spyOn(SessionRepositoryStore.prototype, "listRepositoryIds").mockResolvedValue([
      { repoOwner: "acme", repoName: "web", repoId: 123 },
      { repoOwner: "acme", repoName: "api", repoId: 456 },
    ]);
    vi.spyOn(TeamRepositoryGrantStore.prototype, "listForTeam").mockResolvedValue([
      { grant_kind: "repository", repo_external_id: 123 },
      { grant_kind: "repository", repo_external_id: 456 },
    ]);
    vi.mocked(loadInstallationRepositories).mockReset().mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    sqlite.close();
  });

  function createHarness(teamsEnforcement = "off") {
    const storage = createNodeSqlStorage(sqlite);
    initSchema(storage.sql);
    storage.sql.exec(
      `INSERT INTO session (id, session_name, repo_owner, repo_name, created_at, updated_at)
       VALUES ('internal-session', 'public-session', 'acme', 'web', 1, 1)`
    );
    const db = createNodeSqlDatabase(sqlite);
    const env = {
      REPO_SECRETS_ENCRYPTION_KEY: btoa("0".repeat(32)),
      MODAL_API_SECRET: "modal-secret",
      MODAL_WORKSPACE: "test-workspace",
      TEAMS_ENFORCEMENT: teamsEnforcement,
      LOG_LEVEL: "error",
    } as Env;
    const runtime = createSessionRuntime(
      {
        id: "durable-object-id",
        storage,
        db,
        alarmStore: {
          getAlarm: async () => null,
          setAlarm: async () => {},
          deleteAlarm: async () => {},
        },
        sockets: {
          adopt: () => {},
          tags: () => [],
          sockets: () => [],
          setAutoResponse: () => {},
        },
        createBackgroundTasks: () => ({ submit: () => {} }),
      },
      env
    );
    const generateCredentialHelperAuth = vi.fn(async () => ({
      username: "x-access-token",
      password: "scoped-token",
      expiresAtEpochMs: Date.now() + 60_000,
    }));
    runtime.internals.sourceControlProvider = {
      name: "github",
      generateCredentialHelperAuth,
    } as unknown as SourceControlProvider;
    return {
      env,
      generateCredentialHelperAuth,
      getCredentials: () =>
        runtime.server.onRequest(
          buildSessionInternalRequest(SessionInternalPaths.scmCredentials, { method: "POST" })
        ),
    };
  }

  it.each(["off", "shadow", "on"])(
    "scopes credentials to D1 session members and team grants with TEAMS_ENFORCEMENT=%s",
    async (mode) => {
      const getSession = vi
        .spyOn(SessionIndexStore.prototype, "get")
        .mockResolvedValue(indexSession("team-a"));
      const scope: CredentialScope = { kind: "repositories", repositoryIds: [123, 456] };
      const h = createHarness(mode);

      expect((await h.getCredentials()).status).toBe(200);

      expect(getSession).toHaveBeenCalledWith("public-session");
      expect(SessionRepositoryStore.prototype.listRepositoryIds).toHaveBeenCalledWith(
        "public-session"
      );
      expect(TeamRepositoryGrantStore.prototype.listForTeam).toHaveBeenCalledExactlyOnceWith(
        "team-a"
      );
      expect(h.generateCredentialHelperAuth).toHaveBeenCalledWith(scope);
      expect(loadInstallationRepositories).not.toHaveBeenCalled();
    }
  );

  it("re-reads D1 ownership and membership for every credential request", async () => {
    const getSession = vi
      .spyOn(SessionIndexStore.prototype, "get")
      .mockResolvedValueOnce(indexSession("team-a"))
      .mockResolvedValueOnce(indexSession("team-b"));
    const firstScope: CredentialScope = { kind: "repositories", repositoryIds: [123, 456] };
    const nextScope: CredentialScope = { kind: "repositories", repositoryIds: [789] };
    vi.mocked(SessionRepositoryStore.prototype.listRepositoryIds)
      .mockResolvedValueOnce([
        { repoOwner: "acme", repoName: "web", repoId: 123 },
        { repoOwner: "acme", repoName: "api", repoId: 456 },
      ])
      .mockResolvedValueOnce([{ repoOwner: "acme", repoName: "cli", repoId: 789 }]);
    vi.mocked(TeamRepositoryGrantStore.prototype.listForTeam)
      .mockResolvedValueOnce([
        { grant_kind: "repository", repo_external_id: 123 },
        { grant_kind: "repository", repo_external_id: 456 },
      ])
      .mockResolvedValueOnce([{ grant_kind: "repository", repo_external_id: 789 }]);
    const h = createHarness();

    expect((await h.getCredentials()).status).toBe(200);
    expect((await h.getCredentials()).status).toBe(200);

    expect(getSession).toHaveBeenCalledTimes(2);
    expect(SessionRepositoryStore.prototype.listRepositoryIds).toHaveBeenCalledTimes(2);
    expect(TeamRepositoryGrantStore.prototype.listForTeam).toHaveBeenCalledTimes(2);
    expect(TeamRepositoryGrantStore.prototype.listForTeam).toHaveBeenNthCalledWith(1, "team-a");
    expect(TeamRepositoryGrantStore.prototype.listForTeam).toHaveBeenNthCalledWith(2, "team-b");
    expect(h.generateCredentialHelperAuth).toHaveBeenNthCalledWith(1, firstScope);
    expect(h.generateCredentialHelperAuth).toHaveBeenNthCalledWith(2, nextScope);
  });

  it("limits an existing workspace session to its own repositories", async () => {
    vi.spyOn(SessionIndexStore.prototype, "get").mockResolvedValue(indexSession(null));
    const h = createHarness();

    expect((await h.getCredentials()).status).toBe(200);

    expect(TeamRepositoryGrantStore.prototype.listForTeam).not.toHaveBeenCalled();
    expect(h.generateCredentialHelperAuth).toHaveBeenCalledWith({
      kind: "repositories",
      repositoryIds: [123, 456],
    });
    expect(loadInstallationRepositories).not.toHaveBeenCalled();
  });

  it("lazily loads the installation catalog for a NULL member id", async () => {
    vi.spyOn(SessionIndexStore.prototype, "get").mockResolvedValue(indexSession(null));
    vi.mocked(SessionRepositoryStore.prototype.listRepositoryIds).mockResolvedValue([
      { repoOwner: "acme", repoName: "web", repoId: null },
      { repoOwner: "acme", repoName: "api", repoId: 456 },
    ]);
    vi.mocked(loadInstallationRepositories).mockResolvedValue([
      {
        id: 123,
        owner: "ACME",
        name: "Web",
        fullName: "ACME/Web",
        description: null,
        private: true,
        defaultBranch: "main",
        archived: false,
      },
      {
        id: 999,
        owner: "acme",
        name: "not-in-session",
        fullName: "acme/not-in-session",
        description: null,
        private: true,
        defaultBranch: "main",
        archived: false,
      },
    ]);
    const h = createHarness();
    expect(loadInstallationRepositories).not.toHaveBeenCalled();

    expect((await h.getCredentials()).status).toBe(200);

    expect(loadInstallationRepositories).toHaveBeenCalledExactlyOnceWith(h.env, expect.anything());
    expect(h.generateCredentialHelperAuth).toHaveBeenCalledWith({
      kind: "repositories",
      repositoryIds: [123, 456],
    });
  });

  it("drops revoked member grants instead of including the team's other repositories", async () => {
    vi.spyOn(SessionIndexStore.prototype, "get").mockResolvedValue(indexSession("team-a"));
    vi.mocked(TeamRepositoryGrantStore.prototype.listForTeam)
      .mockResolvedValueOnce([
        { grant_kind: "repository", repo_external_id: 123 },
        { grant_kind: "repository", repo_external_id: 789 },
      ])
      .mockResolvedValueOnce([{ grant_kind: "repository", repo_external_id: 456 }]);
    const h = createHarness();

    expect((await h.getCredentials()).status).toBe(200);

    expect(TeamRepositoryGrantStore.prototype.listForTeam).toHaveBeenCalledExactlyOnceWith(
      "team-a"
    );
    expect(h.generateCredentialHelperAuth).toHaveBeenNthCalledWith(1, {
      kind: "repositories",
      repositoryIds: [123],
    });

    expect((await h.getCredentials()).status).toBe(200);

    expect(TeamRepositoryGrantStore.prototype.listForTeam).toHaveBeenCalledTimes(2);
    expect(TeamRepositoryGrantStore.prototype.listForTeam).toHaveBeenNthCalledWith(2, "team-a");
    expect(h.generateCredentialHelperAuth).toHaveBeenNthCalledWith(2, {
      kind: "repositories",
      repositoryIds: [456],
    });
  });

  it.each([
    { label: "no repositories", repositories: [] },
    {
      label: "an unresolved NULL id",
      repositories: [{ repoOwner: "acme", repoName: "web", repoId: null }],
    },
  ])("refuses credential minting with $label", async ({ repositories }) => {
    vi.spyOn(SessionIndexStore.prototype, "get").mockResolvedValue(indexSession("team-a"));
    vi.mocked(SessionRepositoryStore.prototype.listRepositoryIds).mockResolvedValue(repositories);
    const h = createHarness();

    expect((await h.getCredentials()).status).toBe(500);

    expect(TeamRepositoryGrantStore.prototype.listForTeam).not.toHaveBeenCalled();
    expect(h.generateCredentialHelperAuth).not.toHaveBeenCalled();
  });

  it("refuses credential minting when every member grant has been revoked", async () => {
    vi.spyOn(SessionIndexStore.prototype, "get").mockResolvedValue(indexSession("team-a"));
    vi.mocked(TeamRepositoryGrantStore.prototype.listForTeam).mockResolvedValue([]);
    const h = createHarness();

    expect((await h.getCredentials()).status).toBe(500);

    expect(TeamRepositoryGrantStore.prototype.listForTeam).toHaveBeenCalledExactlyOnceWith(
      "team-a"
    );
    expect(h.generateCredentialHelperAuth).not.toHaveBeenCalled();
  });

  it("fails closed when the D1 session is missing despite an existing local session", async () => {
    vi.spyOn(SessionIndexStore.prototype, "get").mockResolvedValue(null);
    const h = createHarness();

    const response = await h.getCredentials();

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "Cannot resolve credential scope: session not found",
    });
    expect(SessionRepositoryStore.prototype.listRepositoryIds).not.toHaveBeenCalled();
    expect(TeamRepositoryGrantStore.prototype.listForTeam).not.toHaveBeenCalled();
    expect(loadInstallationRepositories).not.toHaveBeenCalled();
    expect(h.generateCredentialHelperAuth).not.toHaveBeenCalled();
  });
});
