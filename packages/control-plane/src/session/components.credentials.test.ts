import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionIndexStore, type SessionEntry } from "../db/session-index";
import { SessionRepositoryStore } from "../db/session-repositories";
import { createNodeSqlDatabase } from "../node/sqlite-database";
import { createNodeSqlStorage } from "../node/sqlite-storage";
import { readCachedInstallationRepositories } from "../repos/cache";
import type { SourceControlProvider } from "../source-control";
import type { Env } from "../types";
import { createSessionRuntime } from "./components";
import { buildSessionInternalRequest, SessionInternalPaths } from "./contracts";
import { initSchema } from "./schema";

vi.mock("../repos/cache", () => ({ readCachedInstallationRepositories: vi.fn() }));

describe("session credential scope composition", () => {
  let sqlite: DatabaseSync;

  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    vi.mocked(readCachedInstallationRepositories).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    sqlite.close();
  });

  function createHarness() {
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

  it("mints credentials for the scope resolved from D1 for the public session id", async () => {
    const getSession = vi
      .spyOn(SessionIndexStore.prototype, "get")
      .mockResolvedValue({ id: "public-session", ownerTeamId: null } as SessionEntry);
    vi.spyOn(SessionRepositoryStore.prototype, "listRepositoryIds").mockResolvedValue([
      { repoOwner: "acme", repoName: "web", repoId: null },
      { repoOwner: "acme", repoName: "api", repoId: 456 },
    ]);
    vi.mocked(readCachedInstallationRepositories).mockResolvedValue([
      {
        id: 123,
        owner: "acme",
        name: "web",
        fullName: "acme/web",
        description: null,
        private: true,
        defaultBranch: "main",
        archived: false,
      },
    ]);
    const h = createHarness();

    expect((await h.getCredentials()).status).toBe(200);

    expect(getSession).toHaveBeenCalledWith("public-session");
    expect(readCachedInstallationRepositories).toHaveBeenCalledWith(h.env);
    expect(h.generateCredentialHelperAuth).toHaveBeenCalledWith({
      kind: "repositories",
      repositoryIds: [123, 456],
    });
  });

  it("fails closed when the D1 session is missing despite an existing local session", async () => {
    vi.spyOn(SessionIndexStore.prototype, "get").mockResolvedValue(null);
    const h = createHarness();

    const response = await h.getCredentials();

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "Cannot resolve credential scope: session not found",
    });
    expect(h.generateCredentialHelperAuth).not.toHaveBeenCalled();
  });
});
