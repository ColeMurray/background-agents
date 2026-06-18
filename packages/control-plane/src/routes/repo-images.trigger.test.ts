import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRequestMetrics } from "../db/instrumented-d1";
import { repoImageRoutes } from "./repo-images";
import type { Env } from "../types";
import type { RequestContext, Route } from "./shared";
import type { RepositoryAccessResult } from "../source-control";
import type * as SourceControlModule from "../source-control";
import type * as SandboxClientModule from "../sandbox/client";

// handleTriggerBuild resolves the repo's actual default branch (never assumes
// "main") and threads it into the build record + the Modal build backend. These
// tests pin that contract: the resolved branch must flow through, and a repo
// that can't be resolved must fail the trigger instead of silently building the
// wrong branch.

const scmProvider = vi.hoisted(() => ({
  checkRepositoryAccess: vi.fn(),
}));

const modalClient = vi.hoisted(() => ({
  buildRepoImage: vi.fn(),
}));

vi.mock("../source-control", async (importOriginal) => {
  const actual = await importOriginal<typeof SourceControlModule>();
  return {
    ...actual,
    createSourceControlProviderFromEnv: vi.fn(() => scmProvider),
  };
});

vi.mock("../sandbox/client", async (importOriginal) => {
  const actual = await importOriginal<typeof SandboxClientModule>();
  return {
    ...actual,
    createModalClient: vi.fn(() => modalClient),
  };
});

const TRIGGER_PATH = "/repo-images/trigger/acme/repo";

function triggerRoute(): Route {
  const route = repoImageRoutes.find((candidate) => candidate.pattern.test(TRIGGER_PATH));
  if (!route) throw new Error("trigger route not found");
  return route;
}

function triggerMatch(): RegExpMatchArray {
  const match = TRIGGER_PATH.match(triggerRoute().pattern);
  if (!match) throw new Error("trigger path did not match route pattern");
  return match;
}

function createContext(): RequestContext {
  return {
    request_id: "request-1",
    trace_id: "trace-1",
    metrics: createRequestMetrics(),
    executionCtx: {
      waitUntil: () => {},
    } as unknown as ExecutionContext,
  };
}

interface RecordedRun {
  sql: string;
  args: unknown[];
}

function createRecordingDb(runs: RecordedRun[]): D1Database {
  return {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        run: async () => {
          runs.push({ sql, args });
          return { meta: { changes: 1 } };
        },
        first: async () => null,
        all: async () => ({ results: [] }),
      }),
    }),
  } as unknown as D1Database;
}

function createEnv(db: D1Database): Env {
  return {
    DB: db,
    SANDBOX_PROVIDER: "modal",
    WORKER_URL: "https://cp.test",
    MODAL_API_SECRET: "modal-secret",
    MODAL_WORKSPACE: "modal-ws",
  } as Env;
}

async function callTrigger(runs: RecordedRun[]): Promise<Response> {
  return triggerRoute().handler(
    new Request(`https://test.local${TRIGGER_PATH}`, { method: "POST" }),
    createEnv(createRecordingDb(runs)),
    triggerMatch(),
    createContext()
  );
}

describe("POST /repo-images/trigger/:owner/:name", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    modalClient.buildRepoImage.mockResolvedValue(undefined);
  });

  it("resolves the repository's default branch and threads it into the build", async () => {
    const resolved: RepositoryAccessResult = {
      repoId: 123,
      repoOwner: "acme",
      repoName: "repo",
      defaultBranch: "develop",
    };
    scmProvider.checkRepositoryAccess.mockResolvedValue(resolved);

    const runs: RecordedRun[] = [];
    const response = await callTrigger(runs);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      buildId: expect.stringContaining("img-acme-repo-"),
      status: "building",
    });

    // Resolution is keyed off the path params, not a hardcoded branch.
    expect(scmProvider.checkRepositoryAccess).toHaveBeenCalledWith({
      owner: "acme",
      name: "repo",
    });

    // The resolved branch — not "main" — reaches the Modal build backend...
    expect(modalClient.buildRepoImage).toHaveBeenCalledTimes(1);
    expect(modalClient.buildRepoImage).toHaveBeenCalledWith(
      expect.objectContaining({
        repoOwner: "acme",
        repoName: "repo",
        defaultBranch: "develop",
      }),
      expect.any(Object)
    );

    // ...and is persisted as the build's base_branch.
    const insert = runs.find((run) => run.sql.includes("INSERT INTO repo_images"));
    expect(insert).toBeDefined();
    expect(insert?.args).toContain("develop");
    expect(insert?.args).not.toContain("main");
  });

  it("returns 404 without building when the repository is not installed", async () => {
    scmProvider.checkRepositoryAccess.mockResolvedValue(null);

    const runs: RecordedRun[] = [];
    const response = await callTrigger(runs);

    expect(response.status).toBe(404);
    expect(modalClient.buildRepoImage).not.toHaveBeenCalled();
    expect(runs.find((run) => run.sql.includes("INSERT INTO repo_images"))).toBeUndefined();
  });

  it("returns 500 without building when repository resolution fails", async () => {
    scmProvider.checkRepositoryAccess.mockRejectedValue(new Error("github unavailable"));

    const runs: RecordedRun[] = [];
    const response = await callTrigger(runs);

    expect(response.status).toBe(500);
    expect(modalClient.buildRepoImage).not.toHaveBeenCalled();
    expect(runs.find((run) => run.sql.includes("INSERT INTO repo_images"))).toBeUndefined();
  });
});
