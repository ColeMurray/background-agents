import { describe, it, expect } from "vitest";
import { resolveSessionRepoId } from "./repo-id-resolution";
import { SessionCoreRepository } from "./session-core-repository";
import type { SqlResult, SqlStorage } from "./sql-storage";
import type { SourceControlProvider, RepositoryAccessResult } from "../source-control";
import type { SessionRow } from "./types";

function notUsedHere(member: string): never {
  throw new Error(`${member} is not exercised by the repo-id-resolution suite`);
}

/** Full-interface stub so no test needs an unsafe cast. */
function stubProvider(
  checkRepositoryAccess: SourceControlProvider["checkRepositoryAccess"]
): SourceControlProvider {
  return {
    name: "github",
    getRepository: () => notUsedHere("getRepository"),
    createPullRequest: () => notUsedHere("createPullRequest"),
    checkRepositoryAccess,
    listRepositories: () => notUsedHere("listRepositories"),
    listBranches: () => notUsedHere("listBranches"),
    getBranchHead: () => notUsedHere("getBranchHead"),
    resolveCommit: () => notUsedHere("resolveCommit"),
    listTree: () => notUsedHere("listTree"),
    readBlob: () => notUsedHere("readBlob"),
    getPullRequest: () => notUsedHere("getPullRequest"),
    generatePushAuth: () => notUsedHere("generatePushAuth"),
    generateCredentialHelperAuth: () => notUsedHere("generateCredentialHelperAuth"),
    buildManualPullRequestUrl: () => notUsedHere("buildManualPullRequestUrl"),
    buildGitPushSpec: () => notUsedHere("buildGitPushSpec"),
  };
}

function sessionRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "sess-1",
    session_name: "sess-public-1",
    title: null,
    repo_owner: "acme",
    repo_name: "web",
    repo_id: 90101,
    base_branch: "main",
    branch_name: null,
    base_sha: null,
    current_sha: null,
    opencode_session_id: null,
    model: "anthropic/claude-sonnet-4-5",
    reasoning_effort: null,
    status: "active",
    parent_session_id: null,
    spawn_source: "user",
    spawn_depth: 0,
    code_server_enabled: 0,
    vnc_enabled: 0,
    total_cost: 0,
    sandbox_settings: null,
    environment_id: null,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

function makeHarness(
  checkRepositoryAccess: SourceControlProvider["checkRepositoryAccess"] = () =>
    notUsedHere("checkRepositoryAccess")
) {
  const updates: Array<{ query: string; params: unknown[] }> = [];
  const sql: SqlStorage = {
    exec(query: string, ...params: unknown[]): SqlResult {
      if (!query.startsWith("UPDATE session SET repo_id")) {
        throw new Error(`Unexpected DO storage query: ${query}`);
      }
      updates.push({ query, params });
      return { toArray: () => [], one: () => null, rowsWritten: 1 };
    },
  };
  const repository = new SessionCoreRepository(sql, (closure) => closure());
  const provider = stubProvider(checkRepositoryAccess);
  let providerThunkCalls = 0;
  const getProvider = () => {
    providerThunkCalls += 1;
    return provider;
  };
  return {
    resolve: (session: SessionRow) => resolveSessionRepoId(session, repository, getProvider),
    updates,
    providerThunkCalls: () => providerThunkCalls,
  };
}

describe("resolveSessionRepoId", () => {
  it("short-circuits on an existing repo_id without touching the provider or persisting", async () => {
    const h = makeHarness();

    await expect(h.resolve(sessionRow())).resolves.toBe(90101);

    expect(h.providerThunkCalls()).toBe(0);
    expect(h.updates).toEqual([]);
  });

  it("throws when the session has no repository context", async () => {
    const h = makeHarness();

    await expect(
      h.resolve(sessionRow({ repo_id: null, repo_owner: null, repo_name: null }))
    ).rejects.toThrow("Session has no repository context");
  });

  it("throws when the repository is not accessible", async () => {
    const h = makeHarness(async () => null);

    await expect(h.resolve(sessionRow({ repo_id: null }))).rejects.toThrow(
      "Repository is not accessible for the configured SCM provider"
    );
    expect(h.updates).toEqual([]);
  });

  it("resolves via the provider and persists the repo id for legacy rows", async () => {
    const checked: Array<{ owner: string; name: string }> = [];
    const access: RepositoryAccessResult = {
      repoId: 777,
      repoOwner: "acme",
      repoName: "web",
      defaultBranch: "main",
    };
    const h = makeHarness(async ({ owner, name }) => {
      checked.push({ owner, name });
      return access;
    });

    await expect(h.resolve(sessionRow({ repo_id: null }))).resolves.toBe(777);

    expect(checked).toEqual([{ owner: "acme", name: "web" }]);
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]?.params).toEqual([777]);
  });
});
