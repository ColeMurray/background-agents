import type { PermissionId } from "@open-inspect/shared/rbac";
import { describe, expect, it, vi } from "vitest";
import type { SqlDatabase } from "../db/sql-database";
import { TEST_BACKGROUND_TASK_CONTEXT } from "../router.test-support";
import { SessionInternalPaths } from "../session/contracts";
import type { Env } from "../types";
import { externalSessionResourceRoutes } from "./external-session-resources";
import type { RequestContext } from "./shared";

interface TestData {
  sessions?: Record<string, Record<string, unknown>>;
  children?: Record<string, Array<Record<string, unknown>>>;
  pullRequests?: Array<Record<string, unknown>>;
  repositories?: Array<Record<string, unknown>>;
}

function sessionRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: id,
    repo_owner: "group/subgroup",
    repo_name: "repo",
    model: "openai/gpt-5.6-sol",
    reasoning_effort: "high",
    base_branch: "main",
    status: "active",
    parent_session_id: null,
    root_session_id: id,
    spawn_source: "user",
    spawn_depth: 0,
    automation_id: null,
    automation_run_id: null,
    scm_login: null,
    user_id: "user-1",
    total_cost: 0,
    active_duration_ms: 0,
    message_count: 0,
    pr_count: 0,
    environment_id: null,
    external_request_fingerprint: null,
    external_bootstrap_snapshot: null,
    created_at: 1,
    updated_at: 2,
    ...overrides,
  };
}

function createDb(data: TestData): SqlDatabase {
  return {
    prepare: (query: string) => {
      let params: unknown[] = [];
      const statement = {
        bind: (...values: unknown[]) => {
          params = values;
          return statement;
        },
        first: async () => {
          if (query.includes("FROM sessions WHERE id = ?")) {
            return data.sessions?.[String(params[0])] ?? null;
          }
          if (query.includes("session_pull_requests WHERE artifact_id = ?")) {
            return data.pullRequests?.find((row) => row.artifact_id === params[0]) ?? null;
          }
          return null;
        },
        all: async () => {
          if (query.includes("FROM sessions WHERE parent_session_id = ?")) {
            return { results: data.children?.[String(params[0])] ?? [] };
          }
          if (query.includes("FROM session_repositories")) {
            return { results: data.repositories ?? [] };
          }
          if (query.includes("FROM session_pull_requests") && query.includes("GROUP BY")) {
            return { results: [] };
          }
          if (query.includes("FROM session_pull_requests") && query.includes("session_id = ?")) {
            return {
              results: data.pullRequests?.filter((row) => row.session_id === params[0]) ?? [],
            };
          }
          return { results: [] };
        },
      };
      return statement;
    },
  } as unknown as SqlDatabase;
}

function createContext(
  db: SqlDatabase,
  permissions: PermissionId[] = ["sessions.read"]
): RequestContext {
  return {
    trace_id: "trace-1",
    request_id: "request-1",
    db,
    executionCtx: TEST_BACKGROUND_TASK_CONTEXT,
    principal: { kind: "user", userId: "user-1" },
    authorization: {
      userId: "user-1",
      suspendedAt: null,
      role: { id: "role-1", key: "viewer", name: "Viewer" },
      permissions,
    },
    metrics: {
      d1Queries: [],
      spans: {},
      time: async <T>(_name: string, fn: () => Promise<T>) => fn(),
      summarize: () => ({}),
    },
  };
}

function createEnv(fetch: (request: Request) => Promise<Response>): Env {
  return {
    SCM_PROVIDER: "gitlab",
    SESSION: {
      idFromName: vi.fn((name: string) => `do-${name}`),
      get: vi.fn(() => ({ fetch })),
    },
  } as unknown as Env;
}

function route(method: string, path: string) {
  for (const candidate of externalSessionResourceRoutes) {
    const match = path.match(candidate.pattern);
    if (candidate.method === method && match) return { candidate, match };
  }
  throw new Error(`No route for ${method} ${path}`);
}

describe("external session resource routes", () => {
  it("exports the V1 read routes and scoped mutation routes", () => {
    expect(externalSessionResourceRoutes).toHaveLength(12);
    for (const candidate of externalSessionResourceRoutes) {
      expect(candidate.authentication).toEqual({ kind: "external-user" });
      expect(candidate.supportedScmProviders).toBe("all");
      expect(candidate.authorization).toMatchObject({
        kind: "active-user",
        allOf: [
          {
            kind: "permission",
            permission: candidate.method === "POST" ? "sessions.collaborate" : "sessions.read",
          },
        ],
        service: { kind: "deny" },
      });
    }
  });

  it("defaults message pages to 50, caps them at 100, and parses the runtime projection", async () => {
    const requests: Request[] = [];
    const env = createEnv(async (request) => {
      requests.push(request);
      return Response.json({
        messages: [
          {
            id: "message-1",
            authorId: "participant-1",
            content: "Inspect this",
            source: "extension",
            attachments: null,
            status: "completed",
            createdAt: 1,
            startedAt: 2,
            completedAt: 3,
            callbackContext: "must not escape",
          },
        ],
        hasMore: false,
      });
    });
    const db = createDb({ sessions: { "session-1": sessionRow("session-1") } });
    const path = "/external/v1/sessions/session-1/messages";
    const { candidate, match } = route("GET", path);
    const response = await candidate.handler(
      new Request(`https://test.local${path}`),
      env,
      match,
      createContext(db)
    );

    expect(response.status).toBe(200);
    expect(new URL(requests[0].url).searchParams.get("limit")).toBe("50");
    expect(await response.json()).toEqual({
      messages: [
        {
          id: "message-1",
          authorId: "participant-1",
          content: "Inspect this",
          source: "extension",
          attachments: null,
          status: "completed",
          createdAt: 1,
          startedAt: 2,
          completedAt: 3,
        },
      ],
      hasMore: false,
    });

    const rejected = await candidate.handler(
      new Request(`https://test.local${path}?limit=101`),
      env,
      match,
      createContext(db)
    );
    expect(rejected.status).toBe(400);
    expect(requests).toHaveLength(1);
  });

  it("rejects unknown and duplicate query parameters before reading resources", async () => {
    const runtimeFetch = vi.fn(async () => Response.json({}));
    const env = createEnv(runtimeFetch);
    const db = createDb({ sessions: { "session-1": sessionRow("session-1") } });
    const cases = [
      ["/external/v1/sessions/session-1/messages", "?unknown=value"],
      ["/external/v1/sessions/session-1/artifacts", "?limit=1&limit=2"],
      ["/external/v1/sessions/session-1/diff", "?offset=0&offset=1"],
      ["/external/v1/sessions/session-1/diff/revision-1/files/file-1", "?limit=1&extra=true"],
      ["/external/v1/sessions/session-1/pull-requests/pr-1", "?offset=0"],
      ["/external/v1/sessions/session-1/artifacts/shot-1/content", "?download=true"],
    ] as const;

    for (const [path, query] of cases) {
      const { candidate, match } = route("GET", path);
      const response = await candidate.handler(
        new Request(`https://test.local${path}${query}`),
        env,
        match,
        createContext(db)
      );
      expect(response.status, `${path}${query}`).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "Invalid query parameters" });
    }
    expect(runtimeFetch).not.toHaveBeenCalled();
  });

  it("strips storage-only artifact metadata and pins diff file reads to the route revision", async () => {
    const requests: Request[] = [];
    const env = createEnv(async (request) => {
      requests.push(request);
      const url = new URL(request.url);
      if (url.pathname === SessionInternalPaths.artifacts) {
        return Response.json({
          artifacts: [
            {
              id: "shot-1",
              type: "screenshot",
              url: "/media/shot-1",
              metadata: {
                objectKey: "private/session/shot-1.png",
                mimeType: "image/png",
                sizeBytes: 12,
                caption: "Result",
                encryptedToken: "secret",
              },
              createdAt: 10,
            },
          ],
          hasMore: false,
        });
      }
      return new Response("diff --git a/file.ts b/file.ts", {
        headers: { "Content-Type": "text/x-diff" },
      });
    });
    const db = createDb({ sessions: { "session-1": sessionRow("session-1") } });

    const artifactsPath = "/external/v1/sessions/session-1/artifacts";
    const artifactsRoute = route("GET", artifactsPath);
    const artifactsResponse = await artifactsRoute.candidate.handler(
      new Request(`https://test.local${artifactsPath}`),
      env,
      artifactsRoute.match,
      createContext(db)
    );
    expect(await artifactsResponse.json()).toEqual({
      artifacts: [
        {
          id: "shot-1",
          type: "screenshot",
          url: "/external/v1/sessions/session-1/artifacts/shot-1/content",
          metadata: { mimeType: "image/png", sizeBytes: 12, caption: "Result" },
          createdAt: 10,
          updatedAt: 10,
        },
      ],
      hasMore: false,
    });

    const diffPath = "/external/v1/sessions/session-1/diff/revision-1/files/file-1";
    const diffRoute = route("GET", diffPath);
    const diffResponse = await diffRoute.candidate.handler(
      new Request(`https://test.local${diffPath}`),
      env,
      diffRoute.match,
      createContext(db)
    );
    expect(diffResponse.headers.get("Content-Type")).toBe("application/json");
    await expect(diffResponse.json()).resolves.toEqual({
      content: "diff --git a/file.ts b/file.ts",
      truncated: false,
      hasMore: false,
    });
    expect(new URL(requests[1].url).search).toBe("?revisionId=revision-1&fileId=file-1");
  });

  it("continues artifacts with an opaque runtime cursor instead of reslicing a mutated list", async () => {
    const requests: Request[] = [];
    const env = createEnv(async (request) => {
      requests.push(request);
      const cursor = new URL(request.url).searchParams.get("cursor");
      return Response.json(
        cursor
          ? {
              artifacts: [
                {
                  id: "artifact-a",
                  type: "branch",
                  url: null,
                  metadata: null,
                  createdAt: 1000,
                  updatedAt: 1000,
                },
              ],
              hasMore: false,
            }
          : {
              artifacts: [
                {
                  id: "artifact-c",
                  type: "branch",
                  url: null,
                  metadata: null,
                  createdAt: 1000,
                  updatedAt: 1000,
                },
                {
                  id: "artifact-b",
                  type: "branch",
                  url: null,
                  metadata: null,
                  createdAt: 1000,
                  updatedAt: 1000,
                },
              ],
              cursor: "opaque-artifact-cursor",
              hasMore: true,
            }
      );
    });
    const db = createDb({ sessions: { "session-1": sessionRow("session-1") } });
    const path = "/external/v1/sessions/session-1/artifacts";
    const { candidate, match } = route("GET", path);

    const first = await candidate.handler(
      new Request(`https://test.local${path}?limit=2`),
      env,
      match,
      createContext(db)
    );
    await expect(first.json()).resolves.toMatchObject({
      artifacts: [{ id: "artifact-c" }, { id: "artifact-b" }],
      cursor: "opaque-artifact-cursor",
      hasMore: true,
    });

    const second = await candidate.handler(
      new Request(`https://test.local${path}?limit=2&cursor=opaque-artifact-cursor`),
      env,
      match,
      createContext(db)
    );
    await expect(second.json()).resolves.toMatchObject({
      artifacts: [{ id: "artifact-a" }],
      hasMore: false,
    });
    expect(new URL(requests[1].url).searchParams.get("cursor")).toBe("opaque-artifact-cursor");
  });

  it("rejects a diff file-list continuation after the current revision changes", async () => {
    let revision = 1;
    const diffFile = (id: string) => ({
      id,
      path: `${id}.ts`,
      status: "modified",
      additions: 1,
      deletions: 1,
      renderState: "renderable",
    });
    const env = createEnv(async () => {
      const currentRevision = revision;
      return Response.json({
        version: 1,
        current: {
          version: 1,
          revisionId: `revision-${currentRevision}`,
          triggerMessageId: null,
          capturedAt: currentRevision,
          repositories: [
            {
              status: "ready",
              position: 0,
              repoOwner: "acme",
              repoName: "repo",
              baseSha: "a".repeat(40),
              headSha: "b".repeat(40),
              truncated: false,
              omittedFileCount: 0,
              files: currentRevision === 1 ? [diffFile("file-b"), diffFile("file-a")] : [],
            },
          ],
        },
        lastError: null,
        unavailableReason: null,
      });
    });
    const db = createDb({ sessions: { "session-1": sessionRow("session-1") } });
    const path = "/external/v1/sessions/session-1/diff";
    const { candidate, match } = route("GET", path);

    const first = await candidate.handler(
      new Request(`https://test.local${path}?limit=1`),
      env,
      match,
      createContext(db)
    );
    await expect(first.json()).resolves.toMatchObject({
      current: { revisionId: "revision-1" },
      hasMore: true,
      continuationOffset: 1,
      continuationRevisionId: "revision-1",
    });

    revision = 2;
    const response = await candidate.handler(
      new Request(`https://test.local${path}?limit=1&offset=1&revisionId=revision-1`),
      env,
      match,
      createContext(db)
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Diff revision is stale",
      code: "diff_revision_stale",
      currentRevisionId: "revision-2",
    });
  });

  it("pages revision-pinned diff content by UTF-8 bytes with explicit continuation", async () => {
    const defaultPage = "a".repeat(256 * 1024);
    const patch = `${defaultPage}€tail`;
    const requests: Request[] = [];
    const env = createEnv(async (request) => {
      requests.push(request);
      return new Response(patch, { headers: { "Content-Type": "text/x-diff" } });
    });
    const db = createDb({ sessions: { "session-1": sessionRow("session-1") } });
    const path = "/external/v1/sessions/session-1/diff/revision-1/files/file-1";
    const { candidate, match } = route("GET", path);

    const firstResponse = await candidate.handler(
      new Request(`https://test.local${path}`),
      env,
      match,
      createContext(db)
    );
    expect(await firstResponse.json()).toEqual({
      content: defaultPage,
      truncated: true,
      hasMore: true,
      continuationOffset: 256 * 1024,
    });

    const secondResponse = await candidate.handler(
      new Request(`https://test.local${path}?limit=524288&offset=${256 * 1024}`),
      env,
      match,
      createContext(db)
    );
    expect(await secondResponse.json()).toEqual({
      content: "€tail",
      truncated: false,
      hasMore: false,
    });
    expect(requests.map((request) => new URL(request.url).search)).toEqual([
      "?revisionId=revision-1&fileId=file-1",
      "?revisionId=revision-1&fileId=file-1",
    ]);

    const invalidLimit = await candidate.handler(
      new Request(`https://test.local${path}?limit=524289`),
      env,
      match,
      createContext(db)
    );
    expect(invalidLimit.status).toBe(400);
    expect(requests).toHaveLength(2);

    const splitCodePoint = await candidate.handler(
      new Request(`https://test.local${path}?limit=${256 * 1024 + 1}`),
      env,
      match,
      createContext(db)
    );
    await expect(splitCodePoint.json()).resolves.toMatchObject({
      content: defaultPage,
      continuationOffset: 256 * 1024,
      truncated: true,
      hasMore: true,
    });

    const invalidOffset = await candidate.handler(
      new Request(`https://test.local${path}?offset=${256 * 1024 + 1}`),
      env,
      match,
      createContext(db)
    );
    expect(invalidOffset.status).toBe(400);
    await expect(invalidOffset.json()).resolves.toEqual({ error: "Invalid diff content offset" });
  });

  it("preserves nested repository owners and enforces direct resource relationships", async () => {
    const parent = sessionRow("parent");
    const child = sessionRow("child", {
      parent_session_id: "parent",
      root_session_id: "parent",
      spawn_source: "agent",
      spawn_depth: 1,
    });
    const otherChild = sessionRow("other-child", { parent_session_id: "other-parent" });
    const pullRequest = {
      artifact_id: "pr-1",
      session_id: "parent",
      repository_external_id: "repo-9001",
      repo_owner: "group/subgroup",
      repo_name: "repo",
      pr_number: 7,
      url: "https://gitlab.example/group/subgroup/repo/-/merge_requests/7",
      lifecycle_state: "open",
      is_draft: 0,
      head_branch: "feature",
      base_branch: "main",
      head_sha: "abc",
      provider_created_at: 1,
      provider_updated_at: 2,
      merged_at: null,
      closed_at: null,
      created_at: 1,
      updated_at: 2,
    };
    const db = createDb({
      sessions: { parent, child, "other-child": otherChild },
      children: { parent: [child] },
      repositories: [
        {
          session_id: "child",
          position: 0,
          repo_owner: "group/subgroup",
          repo_name: "repo",
          repo_id: 9001,
          base_branch: "main",
        },
      ],
      pullRequests: [pullRequest],
    });
    const env = createEnv(async () => Response.json({}));

    const childrenPath = "/external/v1/sessions/parent/children";
    const childrenRoute = route("GET", childrenPath);
    const childrenResponse = await childrenRoute.candidate.handler(
      new Request(`https://test.local${childrenPath}`),
      env,
      childrenRoute.match,
      createContext(db)
    );
    const childrenBody = await childrenResponse.json<{
      children: Array<Record<string, unknown>>;
    }>();
    expect(childrenBody.children[0]).toMatchObject({
      id: "child",
      repoOwner: "group/subgroup",
      repositories: [{ repoOwner: "group/subgroup", repoName: "repo" }],
    });

    const wrongChildPath = "/external/v1/sessions/parent/children/other-child";
    const wrongChildRoute = route("GET", wrongChildPath);
    const wrongChildResponse = await wrongChildRoute.candidate.handler(
      new Request(`https://test.local${wrongChildPath}`),
      env,
      wrongChildRoute.match,
      createContext(db)
    );
    expect(wrongChildResponse.status).toBe(404);

    const pullRequestsPath = "/external/v1/sessions/parent/pull-requests";
    const pullRequestsRoute = route("GET", pullRequestsPath);
    const pullRequestsResponse = await pullRequestsRoute.candidate.handler(
      new Request(`https://test.local${pullRequestsPath}`),
      env,
      pullRequestsRoute.match,
      createContext(db)
    );
    await expect(pullRequestsResponse.json()).resolves.toMatchObject({
      pullRequests: [
        {
          id: "pr-1",
          provider: "gitlab",
          repoOwner: "group/subgroup",
          repoName: "repo",
          number: 7,
        },
      ],
    });

    const wrongPrPath = "/external/v1/sessions/child/pull-requests/pr-1";
    const wrongPrRoute = route("GET", wrongPrPath);
    const wrongPrResponse = await wrongPrRoute.candidate.handler(
      new Request(`https://test.local${wrongPrPath}`),
      env,
      wrongPrRoute.match,
      createContext(db)
    );
    expect(wrongPrResponse.status).toBe(404);

    const pullRequestPath = "/external/v1/sessions/parent/pull-requests/pr-1";
    const pullRequestRoute = route("GET", pullRequestPath);
    const pullRequestResponse = await pullRequestRoute.candidate.handler(
      new Request(`https://test.local${pullRequestPath}`),
      env,
      pullRequestRoute.match,
      createContext(db)
    );
    expect(pullRequestResponse.status).toBe(200);
    await expect(pullRequestResponse.json()).resolves.toMatchObject({
      id: "pr-1",
      provider: "gitlab",
      repoOwner: "group/subgroup",
      repoName: "repo",
      number: 7,
    });
  });
});
