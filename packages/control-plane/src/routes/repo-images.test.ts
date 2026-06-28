import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeHmacHex } from "@open-inspect/shared";
import { createRequestMetrics } from "../db/instrumented-d1";
import { repoImageRoutes } from "./repo-images";
import type { RepoImageProvider } from "../db/repo-images";
import type { Env } from "../types";
import type { RequestContext, Route } from "./shared";
import type * as VercelClientModule from "../sandbox/providers/vercel/client";

const vercelClient = vi.hoisted(() => ({
  snapshotSession: vi.fn(),
  deleteSnapshot: vi.fn(),
  stopSession: vi.fn(),
}));

const VERCEL_CALLBACK_TOKEN = "a".repeat(64);

vi.mock("../sandbox/providers/vercel/client", async (importOriginal) => {
  const actual = await importOriginal<typeof VercelClientModule>();
  return {
    ...actual,
    createVercelSandboxClient: vi.fn(() => vercelClient),
  };
});

interface RepoImageRow {
  id: string;
  repo_owner: string;
  repo_name: string;
  provider: RepoImageProvider;
  provider_session_id: string | null;
  base_branch: string;
  provider_image_id: string;
  status: "building" | "ready" | "failed";
  base_sha: string;
  build_duration_seconds: number | null;
  error_message: string | null;
  callback_token_hash: string | null;
  callback_token_expires_at: number | null;
  callback_token_used_at: number | null;
  created_at: number;
}

function createRepoImageDb(row: RepoImageRow): D1Database {
  const prepare = (sql: string) => ({
    bind: (...args: unknown[]) => ({
      first: async () => {
        if (sql.includes("SELECT id, provider, provider_session_id")) {
          return row.id === args[0] && row.provider === args[1]
            ? {
                id: row.id,
                provider: row.provider,
                provider_session_id: row.provider_session_id,
                status: row.status,
                callback_token_hash: row.callback_token_hash,
                callback_token_expires_at: row.callback_token_expires_at,
                callback_token_used_at: row.callback_token_used_at,
              }
            : null;
        }
        if (sql.includes("SELECT repo_owner, repo_name, provider, base_branch")) {
          return row.id === args[0] && row.provider === args[1] && row.status === "building"
            ? {
                repo_owner: row.repo_owner,
                repo_name: row.repo_name,
                provider: row.provider,
                base_branch: row.base_branch,
                created_at: row.created_at,
              }
            : null;
        }
        return null;
      },
      all: async () => {
        if (sql.includes("SELECT id, provider_image_id")) {
          return { results: [] };
        }
        return { results: [] };
      },
      run: async () => {
        if (sql.includes("UPDATE repo_images SET callback_token_used_at")) {
          row.callback_token_used_at = Number(args[0]);
        } else if (sql.includes("SET status = 'ready'")) {
          row.status = "ready";
          row.provider_image_id = String(args[0]);
          row.base_sha = String(args[1]);
          row.build_duration_seconds = Number(args[2]);
        } else if (sql.includes("UPDATE repo_images SET status = 'failed'")) {
          row.status = "failed";
          row.error_message = String(args[0]);
        }
        return { meta: { changes: 1 } };
      },
    }),
  });

  return {
    prepare,
    batch: async (statements: Array<{ run: () => Promise<unknown> }>) => {
      for (const statement of statements) {
        await statement.run();
      }
      return [];
    },
  } as unknown as D1Database;
}

function buildCompleteRoute(): Route {
  const route = repoImageRoutes.find((candidate) =>
    candidate.pattern.test("/repo-images/build-complete")
  );
  if (!route) throw new Error("build-complete route not found");
  return route;
}

function createContext(waitUntilPromises: Promise<unknown>[]): RequestContext {
  return {
    request_id: "request-1",
    trace_id: "trace-1",
    metrics: createRequestMetrics(),
    executionCtx: {
      waitUntil: (promise: Promise<unknown>) => {
        waitUntilPromises.push(promise);
      },
    } as unknown as ExecutionContext,
  };
}

function createEnv(db: D1Database): Env {
  return {
    DB: db,
    INTERNAL_CALLBACK_SECRET: "callback-secret",
    SANDBOX_PROVIDER: "vercel",
    VERCEL_TOKEN: "vercel-token",
    VERCEL_PROJECT_ID: "project-123",
    TOKEN_ENCRYPTION_KEY: "token-key",
    DEPLOYMENT_NAME: "test",
  } as Env;
}

describe("repo image routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vercelClient.snapshotSession.mockResolvedValue({
      snapshot: { id: "vercel-snapshot-1", status: "created", createdAt: 123 },
      session: {
        id: "vercel-session-1",
        status: "stopped",
        createdAt: 123,
        cwd: "/workspace",
        timeout: 1800000,
      },
    });
    vercelClient.stopSession.mockResolvedValue(undefined);
  });

  it("snapshots Vercel repo image builds outside the build sandbox before marking ready", async () => {
    const waitUntilPromises: Promise<unknown>[] = [];
    const token = VERCEL_CALLBACK_TOKEN;
    const tokenHash = await computeHmacHex(`repo-image-callback:${token}`, "callback-secret");
    const row: RepoImageRow = {
      id: "build-1",
      repo_owner: "acme",
      repo_name: "repo",
      provider: "vercel",
      provider_session_id: "vercel-session-1",
      base_branch: "main",
      provider_image_id: "",
      status: "building",
      base_sha: "",
      build_duration_seconds: null,
      error_message: null,
      callback_token_hash: tokenHash,
      callback_token_expires_at: Date.now() + 60_000,
      callback_token_used_at: null,
      created_at: Date.now(),
    };

    const response = await buildCompleteRoute().handler(
      new Request("https://test.local/repo-images/build-complete", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          build_id: "build-1",
          provider_session_id: "vercel-session-1",
          base_sha: "abc123",
          build_duration_seconds: 42.25,
        }),
      }),
      createEnv(createRepoImageDb(row)),
      [] as unknown as RegExpMatchArray,
      createContext(waitUntilPromises)
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, snapshotPending: true });

    expect(waitUntilPromises).toHaveLength(1);
    await Promise.all(waitUntilPromises);

    expect(vercelClient.snapshotSession).toHaveBeenCalledWith(
      "vercel-session-1",
      { expirationMs: 0 },
      expect.objectContaining({
        request_id: "request-1",
        trace_id: "trace-1",
        sandbox_id: "vercel-session-1",
      })
    );
    expect(vercelClient.stopSession).toHaveBeenCalledWith(
      "vercel-session-1",
      expect.objectContaining({
        request_id: "request-1",
        trace_id: "trace-1",
        sandbox_id: "vercel-session-1",
      })
    );
    expect(row.status).toBe("ready");
    expect(row.provider_image_id).toBe("vercel-snapshot-1");
    expect(row.base_sha).toBe("abc123");
    expect(row.build_duration_seconds).toBe(42.25);
    expect(row.callback_token_used_at).toEqual(expect.any(Number));
  });

  it("rejects Vercel callbacks for an unbound provider session", async () => {
    const token = VERCEL_CALLBACK_TOKEN;
    const tokenHash = await computeHmacHex(`repo-image-callback:${token}`, "callback-secret");
    const row: RepoImageRow = {
      id: "build-1",
      repo_owner: "acme",
      repo_name: "repo",
      provider: "vercel",
      provider_session_id: "vercel-session-1",
      base_branch: "main",
      provider_image_id: "",
      status: "building",
      base_sha: "",
      build_duration_seconds: null,
      error_message: null,
      callback_token_hash: tokenHash,
      callback_token_expires_at: Date.now() + 60_000,
      callback_token_used_at: null,
      created_at: Date.now(),
    };

    const response = await buildCompleteRoute().handler(
      new Request("https://test.local/repo-images/build-complete", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          build_id: "build-1",
          provider_session_id: "other-vercel-session",
          base_sha: "abc123",
          build_duration_seconds: 42.25,
        }),
      }),
      createEnv(createRepoImageDb(row)),
      [] as unknown as RegExpMatchArray,
      createContext([])
    );

    expect(response.status).toBe(401);
    expect(vercelClient.snapshotSession).not.toHaveBeenCalled();
    expect(row.status).toBe("building");
    expect(row.callback_token_used_at).toBeNull();
  });
});
