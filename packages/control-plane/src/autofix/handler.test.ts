import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubAutofixEnvelope } from "@open-inspect/shared";
import { SessionIndexStore, type SessionEntry } from "../db/session-index";
import type { SqlDatabase } from "../db/sql-database";
import type { JobDeps } from "../jobs";
import { SourceControlProviderError, type CredentialScope } from "../source-control";
import { resolveTeamTokenScope } from "../source-control/team-scope";
import type { Env } from "../types";
import { handleAutofixJob } from "./handler";
import { AutofixService } from "./service";

vi.mock("../source-control/team-scope", () => ({ resolveTeamTokenScope: vi.fn() }));
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
    vi.mocked(resolveTeamTokenScope).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function createHarness() {
    const db = {} as SqlDatabase;
    await handleAutofixJob(ENVELOPE, { attempts: 1, maxAttempts: 5 }, {
      db,
      env: { GITHUB_BOT_USERNAME: "open-inspect[bot]", TEAMS_ENFORCEMENT: "off" } as Env,
      correlation: { trace_id: "trace-1", request_id: "request-1" },
    } as JobDeps);
    return { db, resolveCredentialScope: vi.mocked(AutofixService).mock.calls[0][7] };
  }

  it("uses the supplied owner session id to resolve fresh D1 team ownership", async () => {
    const getSession = vi
      .spyOn(SessionIndexStore.prototype, "get")
      .mockResolvedValueOnce(indexSession("team-a"))
      .mockResolvedValueOnce(indexSession("team-b"));
    const firstScope: CredentialScope = { kind: "repositories", repositoryIds: [99, 123] };
    const nextScope: CredentialScope = { kind: "repositories", repositoryIds: [456] };
    vi.mocked(resolveTeamTokenScope)
      .mockResolvedValueOnce(firstScope)
      .mockResolvedValueOnce(nextScope);
    const h = await createHarness();

    expect(await h.resolveCredentialScope("owning-public-session")).toEqual(firstScope);
    expect(await h.resolveCredentialScope("owning-public-session")).toEqual(nextScope);

    expect(getSession).toHaveBeenNthCalledWith(1, "owning-public-session");
    expect(getSession).toHaveBeenNthCalledWith(2, "owning-public-session");
    expect(resolveTeamTokenScope).toHaveBeenNthCalledWith(1, h.db, "team-a");
    expect(resolveTeamTokenScope).toHaveBeenNthCalledWith(2, h.db, "team-b");
  });

  it("resolves unrestricted scope only for an existing workspace-owned session", async () => {
    vi.spyOn(SessionIndexStore.prototype, "get").mockResolvedValue(indexSession(null));
    vi.mocked(resolveTeamTokenScope).mockResolvedValue({ kind: "all" });
    const h = await createHarness();

    expect(await h.resolveCredentialScope("owning-public-session")).toEqual({ kind: "all" });

    expect(resolveTeamTokenScope).toHaveBeenCalledWith(h.db, null);
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
    expect(resolveTeamTokenScope).not.toHaveBeenCalled();
  });
});
