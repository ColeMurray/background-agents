import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionIndexStore, type SessionEntry } from "../db/session-index";
import type { SqlDatabase } from "../db/sql-database";
import type { CredentialScope } from "./credential-scope";
import { SourceControlProviderError } from "./errors";
import { resolveSessionCredentialScope } from "./session-scope";
import { resolveTeamTokenScope } from "./team-scope";

vi.mock("./team-scope", () => ({ resolveTeamTokenScope: vi.fn() }));

const db = {} as SqlDatabase;
const SESSION_ID = "public-session";

function indexSession(ownerTeamId: string | null): SessionEntry {
  return { id: SESSION_ID, ownerTeamId } as SessionEntry;
}

describe("resolveSessionCredentialScope", () => {
  beforeEach(() => {
    vi.spyOn(SessionIndexStore.prototype, "get").mockResolvedValue(null);
    vi.mocked(resolveTeamTokenScope).mockReset();
  });

  afterEach(() => vi.restoreAllMocks());

  it("fails closed with the permanent credential error when the session is missing", async () => {
    const error = await resolveSessionCredentialScope(db, SESSION_ID).catch(
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(SourceControlProviderError);
    expect(error).toMatchObject({
      message: "Cannot resolve credential scope: session not found",
      errorType: "permanent",
    });
    expect(SessionIndexStore.prototype.get).toHaveBeenCalledExactlyOnceWith(SESSION_ID);
    expect(resolveTeamTokenScope).not.toHaveBeenCalled();
  });

  it("passes null ownership to the team resolver for an existing workspace session", async () => {
    vi.mocked(SessionIndexStore.prototype.get).mockResolvedValue(indexSession(null));
    vi.mocked(resolveTeamTokenScope).mockResolvedValue({ kind: "all" });

    expect(await resolveSessionCredentialScope(db, SESSION_ID)).toEqual({ kind: "all" });

    expect(resolveTeamTokenScope).toHaveBeenCalledExactlyOnceWith(db, null);
  });

  it("resolves the owning team's scope using the supplied session id and database", async () => {
    vi.mocked(SessionIndexStore.prototype.get).mockResolvedValue(indexSession("team-a"));
    const scope: CredentialScope = { kind: "repositories", repositoryIds: [12, 30] };
    vi.mocked(resolveTeamTokenScope).mockResolvedValue(scope);

    expect(await resolveSessionCredentialScope(db, SESSION_ID)).toBe(scope);

    expect(SessionIndexStore.prototype.get).toHaveBeenCalledExactlyOnceWith(SESSION_ID);
    expect(resolveTeamTokenScope).toHaveBeenCalledExactlyOnceWith(db, "team-a");
  });

  it("re-reads ownership on every call instead of caching a team's scope", async () => {
    vi.mocked(SessionIndexStore.prototype.get)
      .mockResolvedValueOnce(indexSession("team-a"))
      .mockResolvedValueOnce(indexSession("team-b"))
      .mockResolvedValueOnce(indexSession(null));
    const firstScope: CredentialScope = { kind: "repositories", repositoryIds: [12, 30] };
    const nextScope: CredentialScope = { kind: "repositories", repositoryIds: [] };
    const workspaceScope: CredentialScope = { kind: "all" };
    vi.mocked(resolveTeamTokenScope)
      .mockResolvedValueOnce(firstScope)
      .mockResolvedValueOnce(nextScope)
      .mockResolvedValueOnce(workspaceScope);

    expect(await resolveSessionCredentialScope(db, SESSION_ID)).toBe(firstScope);
    expect(await resolveSessionCredentialScope(db, SESSION_ID)).toBe(nextScope);
    expect(await resolveSessionCredentialScope(db, SESSION_ID)).toBe(workspaceScope);

    expect(SessionIndexStore.prototype.get).toHaveBeenCalledTimes(3);
    expect(SessionIndexStore.prototype.get).toHaveBeenNthCalledWith(1, SESSION_ID);
    expect(SessionIndexStore.prototype.get).toHaveBeenNthCalledWith(2, SESSION_ID);
    expect(SessionIndexStore.prototype.get).toHaveBeenNthCalledWith(3, SESSION_ID);
    expect(resolveTeamTokenScope).toHaveBeenNthCalledWith(1, db, "team-a");
    expect(resolveTeamTokenScope).toHaveBeenNthCalledWith(2, db, "team-b");
    expect(resolveTeamTokenScope).toHaveBeenNthCalledWith(3, db, null);
  });

  it("propagates session-store failures without resolving a fallback scope", async () => {
    const error = new Error("Session store unavailable");
    vi.mocked(SessionIndexStore.prototype.get).mockRejectedValueOnce(error);

    await expect(resolveSessionCredentialScope(db, SESSION_ID)).rejects.toBe(error);

    expect(resolveTeamTokenScope).not.toHaveBeenCalled();
  });

  it("propagates team-scope failures without broadening credentials", async () => {
    vi.mocked(SessionIndexStore.prototype.get).mockResolvedValue(indexSession("team-a"));
    const error = new Error("Grant store unavailable");
    vi.mocked(resolveTeamTokenScope).mockRejectedValueOnce(error);

    await expect(resolveSessionCredentialScope(db, SESSION_ID)).rejects.toBe(error);

    expect(resolveTeamTokenScope).toHaveBeenCalledExactlyOnceWith(db, "team-a");
  });

  it.each<{ label: string; scope: CredentialScope }>([
    { label: "installation-wide", scope: { kind: "all" } },
    { label: "empty repository", scope: { kind: "repositories", repositoryIds: [] } },
    { label: "explicit repository", scope: { kind: "repositories", repositoryIds: [30, 2, 30] } },
  ])("forwards the resolved $label scope unchanged", async ({ scope }) => {
    vi.mocked(SessionIndexStore.prototype.get).mockResolvedValue(indexSession("team-a"));
    vi.mocked(resolveTeamTokenScope).mockResolvedValue(scope);

    expect(await resolveSessionCredentialScope(db, SESSION_ID)).toBe(scope);

    expect(resolveTeamTokenScope).toHaveBeenCalledExactlyOnceWith(db, "team-a");
  });
});
