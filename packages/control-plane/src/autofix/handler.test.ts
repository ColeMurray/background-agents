import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubAutofixEnvelope } from "@open-inspect/shared";
import { SessionIndexStore, type SessionEntry } from "../db/session-index";
import { SessionRepositoryStore } from "../db/session-repositories";
import type { SqlDatabase } from "../db/sql-database";
import type { JobDeps } from "../jobs";
import { readCachedInstallationRepositories } from "../repos/cache";
import { SourceControlProviderError } from "../source-control";
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

const WORKSPACE_SESSION = { id: "owning-public-session", ownerTeamId: null } as SessionEntry;

describe("autofix credential scope composition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(SessionRepositoryStore.prototype, "listRepositoryIds").mockResolvedValue([
      { repoOwner: "acme", repoName: "widgets", repoId: 99 },
      { repoOwner: "acme", repoName: "web", repoId: 123 },
    ]);
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

  it("resolves the owner session's persisted repositories from D1", async () => {
    vi.spyOn(SessionIndexStore.prototype, "get").mockResolvedValue(WORKSPACE_SESSION);
    const h = await createHarness();

    expect(await h.resolveCredentialScope("owning-public-session")).toEqual({
      kind: "repositories",
      repositoryIds: [99, 123],
    });
    expect(SessionRepositoryStore.prototype.listRepositoryIds).toHaveBeenCalledWith(
      "owning-public-session"
    );
  });

  it("loads the cached catalog from env and propagates its failure rather than broadening", async () => {
    vi.spyOn(SessionIndexStore.prototype, "get").mockResolvedValue(WORKSPACE_SESSION);
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

    await expect(h.resolveCredentialScope("owning-public-session")).rejects.toMatchObject({
      errorType: "permanent",
      message: "Cannot resolve credential scope: session not found",
    });
  });
});
