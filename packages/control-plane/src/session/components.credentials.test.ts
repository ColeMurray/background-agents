import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionIndexStore, type SessionEntry } from "../db/session-index";
import { createNodeSqlDatabase } from "../node/sqlite-database";
import { createNodeSqlStorage } from "../node/sqlite-storage";
import type { CredentialScope, SourceControlProvider } from "../source-control";
import { resolveTeamTokenScope } from "../source-control/team-scope";
import type { Env } from "../types";
import { createSessionRuntime } from "./components";
import { buildSessionInternalRequest, SessionInternalPaths } from "./contracts";
import { initSchema } from "./schema";

vi.mock("../source-control/team-scope", () => ({ resolveTeamTokenScope: vi.fn() }));

function indexSession(ownerTeamId: string | null): SessionEntry {
  return { id: "public-session", ownerTeamId } as SessionEntry;
}

describe("session credential scope composition", () => {
  let sqlite: DatabaseSync;

  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    vi.mocked(resolveTeamTokenScope).mockReset();
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
      {
        REPO_SECRETS_ENCRYPTION_KEY: btoa("0".repeat(32)),
        MODAL_API_SECRET: "modal-secret",
        MODAL_WORKSPACE: "test-workspace",
        TEAMS_ENFORCEMENT: teamsEnforcement,
        LOG_LEVEL: "error",
      } as Env
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
      db,
      generateCredentialHelperAuth,
      getCredentials: () =>
        runtime.server.onRequest(
          buildSessionInternalRequest(SessionInternalPaths.scmCredentials, { method: "POST" })
        ),
    };
  }

  it.each(["off", "shadow", "on"])(
    "scopes credentials from D1 public-session ownership with TEAMS_ENFORCEMENT=%s",
    async (mode) => {
      const getSession = vi
        .spyOn(SessionIndexStore.prototype, "get")
        .mockResolvedValue(indexSession("team-a"));
      const scope: CredentialScope = { kind: "repositories", repositoryIds: [123, 456] };
      vi.mocked(resolveTeamTokenScope).mockResolvedValue(scope);
      const h = createHarness(mode);

      expect((await h.getCredentials()).status).toBe(200);

      expect(getSession).toHaveBeenCalledWith("public-session");
      expect(resolveTeamTokenScope).toHaveBeenCalledWith(h.db, "team-a");
      expect(h.generateCredentialHelperAuth).toHaveBeenCalledWith(scope);
    }
  );

  it("re-reads D1 ownership for every credential request", async () => {
    const getSession = vi
      .spyOn(SessionIndexStore.prototype, "get")
      .mockResolvedValueOnce(indexSession("team-a"))
      .mockResolvedValueOnce(indexSession("team-b"));
    const firstScope: CredentialScope = { kind: "repositories", repositoryIds: [123, 456] };
    const nextScope: CredentialScope = { kind: "repositories", repositoryIds: [789] };
    vi.mocked(resolveTeamTokenScope)
      .mockResolvedValueOnce(firstScope)
      .mockResolvedValueOnce(nextScope);
    const h = createHarness();

    expect((await h.getCredentials()).status).toBe(200);
    expect((await h.getCredentials()).status).toBe(200);

    expect(getSession).toHaveBeenCalledTimes(2);
    expect(resolveTeamTokenScope).toHaveBeenNthCalledWith(1, h.db, "team-a");
    expect(resolveTeamTokenScope).toHaveBeenNthCalledWith(2, h.db, "team-b");
    expect(h.generateCredentialHelperAuth).toHaveBeenNthCalledWith(1, firstScope);
    expect(h.generateCredentialHelperAuth).toHaveBeenNthCalledWith(2, nextScope);
  });

  it("passes null ownership to the team resolver only for an existing workspace session", async () => {
    vi.spyOn(SessionIndexStore.prototype, "get").mockResolvedValue(indexSession(null));
    vi.mocked(resolveTeamTokenScope).mockResolvedValue({ kind: "all" });
    const h = createHarness();

    expect((await h.getCredentials()).status).toBe(200);

    expect(resolveTeamTokenScope).toHaveBeenCalledWith(h.db, null);
    expect(h.generateCredentialHelperAuth).toHaveBeenCalledWith({ kind: "all" });
  });

  it("fails closed when the D1 session is missing despite an existing local session", async () => {
    vi.spyOn(SessionIndexStore.prototype, "get").mockResolvedValue(null);
    const h = createHarness();

    const response = await h.getCredentials();

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "Cannot resolve credential scope: session not found",
    });
    expect(resolveTeamTokenScope).not.toHaveBeenCalled();
    expect(h.generateCredentialHelperAuth).not.toHaveBeenCalled();
  });
});
