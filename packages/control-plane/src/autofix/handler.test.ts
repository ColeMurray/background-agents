import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubAutofixEnvelope } from "@open-inspect/shared";
import { SessionIndexStore, type SessionEntry } from "../db/session-index";
import { SessionRepositoryStore } from "../db/session-repositories";
import type { SqlDatabase } from "../db/sql-database";
import { TeamRepositoryGrantStore } from "../db/team-repository-grants";
import type { JobDeps } from "../jobs";
import { readCachedInstallationRepositories } from "../repos/cache";
import { SourceControlProviderError, type CredentialScope } from "../source-control";
import type { Env } from "../types";
import { handleAutofixJob } from "./handler";
import { AutofixService } from "./service";

vi.mock("../repos/cache", () => ({ readCachedInstallationRepositories: vi.fn() }));
vi.mock("./service", () => ({
  AutofixService: vi.fn(function () {
    return {
      process: async () => ({ kind: "completed", decision: "skipped", reason: "disabled" }),
    };
  }),
}));

const ENVELOPE: GitHubAutofixEnvelope = {
  version: 1,
  eventType: "issue_comment",
  action: "created",
  deliveryId: "delivery-1",
  providerObject: { kind: "pr_comment", id: "1234" },
  repository: { id: "99", owner: "acme", name: "widgets" },
  pullRequestNumber: 42,
  receivedAt: "2026-07-30T05:00:00.000Z",
};

function indexSession(ownerTeamId: string | null): SessionEntry {
  return { id: "owning-public-session", ownerTeamId } as SessionEntry;
}

describe("autofix credential scope composition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(SessionRepositoryStore.prototype, "listRepositoryIds").mockResolvedValue([
      { repoOwner: "acme", repoName: "widgets", repoId: 99 },
      { repoOwner: "acme", repoName: "web", repoId: 123 },
    ]);
    vi.spyOn(TeamRepositoryGrantStore.prototype, "covers").mockResolvedValue(true);
    vi.mocked(readCachedInstallationRepositories).mockReset().mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function createHarness() {
    const db = {} as SqlDatabase;
    const env = { GITHUB_BOT_USERNAME: "open-inspect[bot]", TEAMS_ENFORCEMENT: "off" } as Env;
    await handleAutofixJob(ENVELOPE, { attempts: 1, maxAttempts: 5 }, {
      db,
      env,
      correlation: { trace_id: "trace-1", request_id: "request-1" },
    } as JobDeps);
    return { env, resolveCredentialScope: vi.mocked(AutofixService).mock.calls[0][7] };
  }

  it("uses the supplied owner session id to resolve fresh D1 ownership and membership", async () => {
    const getSession = vi
      .spyOn(SessionIndexStore.prototype, "get")
      .mockResolvedValueOnce(indexSession("team-a"))
      .mockResolvedValueOnce(indexSession("team-b"));
    const firstScope: CredentialScope = { kind: "repositories", repositoryIds: [99, 123] };
    const nextScope: CredentialScope = { kind: "repositories", repositoryIds: [456] };
    vi.mocked(SessionRepositoryStore.prototype.listRepositoryIds)
      .mockResolvedValueOnce([
        { repoOwner: "acme", repoName: "widgets", repoId: 99 },
        { repoOwner: "acme", repoName: "web", repoId: 123 },
      ])
      .mockResolvedValueOnce([{ repoOwner: "acme", repoName: "api", repoId: 456 }]);
    const h = await createHarness();

    expect(await h.resolveCredentialScope("owning-public-session")).toEqual(firstScope);
    expect(await h.resolveCredentialScope("owning-public-session")).toEqual(nextScope);

    expect(getSession).toHaveBeenNthCalledWith(1, "owning-public-session");
    expect(getSession).toHaveBeenNthCalledWith(2, "owning-public-session");
    expect(SessionRepositoryStore.prototype.listRepositoryIds).toHaveBeenNthCalledWith(
      1,
      "owning-public-session"
    );
    expect(SessionRepositoryStore.prototype.listRepositoryIds).toHaveBeenNthCalledWith(
      2,
      "owning-public-session"
    );
    expect(TeamRepositoryGrantStore.prototype.covers).toHaveBeenNthCalledWith(
      1,
      "team-a",
      [99, 123]
    );
    expect(TeamRepositoryGrantStore.prototype.covers).toHaveBeenNthCalledWith(2, "team-b", [456]);
    expect(readCachedInstallationRepositories).not.toHaveBeenCalled();
  });

  it("limits workspace-owned autofix credentials to session members", async () => {
    vi.spyOn(SessionIndexStore.prototype, "get").mockResolvedValue(indexSession(null));
    const h = await createHarness();

    expect(await h.resolveCredentialScope("owning-public-session")).toEqual({
      kind: "repositories",
      repositoryIds: [99, 123],
    });

    expect(TeamRepositoryGrantStore.prototype.covers).not.toHaveBeenCalled();
    expect(readCachedInstallationRepositories).not.toHaveBeenCalled();
  });

  it("loads the cached catalog only when the owner session has a NULL repository id", async () => {
    vi.spyOn(SessionIndexStore.prototype, "get").mockResolvedValue(indexSession("team-a"));
    vi.mocked(SessionRepositoryStore.prototype.listRepositoryIds).mockResolvedValue([
      { repoOwner: "acme", repoName: "widgets", repoId: null },
    ]);
    vi.mocked(readCachedInstallationRepositories).mockResolvedValue([
      {
        id: 99,
        owner: "ACME",
        name: "Widgets",
        fullName: "ACME/Widgets",
        description: null,
        private: true,
        defaultBranch: "main",
        archived: false,
      },
    ]);
    const h = await createHarness();
    expect(readCachedInstallationRepositories).not.toHaveBeenCalled();

    expect(await h.resolveCredentialScope("owning-public-session")).toEqual({
      kind: "repositories",
      repositoryIds: [99],
    });

    expect(readCachedInstallationRepositories).toHaveBeenCalledExactlyOnceWith(h.env);
    expect(TeamRepositoryGrantStore.prototype.covers).toHaveBeenCalledExactlyOnceWith(
      "team-a",
      [99]
    );
  });

  it("drops revoked member grants without widening the autofix credential scope", async () => {
    vi.spyOn(SessionIndexStore.prototype, "get").mockResolvedValue(indexSession("team-a"));
    vi.mocked(TeamRepositoryGrantStore.prototype.covers)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const h = await createHarness();

    expect(await h.resolveCredentialScope("owning-public-session")).toEqual({
      kind: "repositories",
      repositoryIds: [99],
    });
  });

  it.each([
    { label: "no repositories", repositories: [] },
    {
      label: "an unresolved NULL id",
      repositories: [{ repoOwner: "acme", repoName: "widgets", repoId: null }],
    },
  ])("refuses an owner session with $label", async ({ repositories }) => {
    vi.spyOn(SessionIndexStore.prototype, "get").mockResolvedValue(indexSession(null));
    vi.mocked(SessionRepositoryStore.prototype.listRepositoryIds).mockResolvedValue(repositories);
    const h = await createHarness();

    await expect(h.resolveCredentialScope("owning-public-session")).rejects.toMatchObject({
      errorType: "permanent",
    });
  });

  it("propagates cached-catalog failures rather than broadening the scope", async () => {
    vi.spyOn(SessionIndexStore.prototype, "get").mockResolvedValue(indexSession(null));
    vi.mocked(SessionRepositoryStore.prototype.listRepositoryIds).mockResolvedValue([
      { repoOwner: "acme", repoName: "widgets", repoId: null },
    ]);
    const error = new SourceControlProviderError("Cached catalog unavailable", "permanent");
    vi.mocked(readCachedInstallationRepositories).mockRejectedValue(error);
    const h = await createHarness();

    await expect(h.resolveCredentialScope("owning-public-session")).rejects.toBe(error);
    expect(readCachedInstallationRepositories).toHaveBeenCalledExactlyOnceWith(h.env);
  });

  it("throws a permanent credential error rather than defaulting a missing D1 session to all", async () => {
    vi.spyOn(SessionIndexStore.prototype, "get").mockResolvedValue(null);
    const h = await createHarness();

    const error = await h
      .resolveCredentialScope("owning-public-session")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SourceControlProviderError);
    expect(error).toMatchObject({
      errorType: "permanent",
      message: "Cannot resolve credential scope: session not found",
    });
    expect(SessionRepositoryStore.prototype.listRepositoryIds).not.toHaveBeenCalled();
    expect(TeamRepositoryGrantStore.prototype.covers).not.toHaveBeenCalled();
    expect(readCachedInstallationRepositories).not.toHaveBeenCalled();
  });
});
