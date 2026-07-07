import { describe, expect, it, vi } from "vitest";
import { resolveSessionRepositories } from "./resolve";
import { HttpError, type RequestContext } from "../routes/shared";
import type { SourceControlProvider, RepositoryAccessResult } from "../source-control";
import type { Env } from "../types";
import type { Logger } from "../logger";

const ctx = { request_id: "req-1", trace_id: "trace-1" } as unknown as RequestContext;
const env = {} as Env;
const logger = {
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function createFakeProvider(
  results: Record<string, RepositoryAccessResult | null | Error>
): SourceControlProvider {
  return {
    checkRepositoryAccess: vi.fn(async ({ owner, name }: { owner: string; name: string }) => {
      const result = results[`${owner}/${name}`];
      if (result instanceof Error) throw result;
      return result ?? null;
    }),
  } as unknown as SourceControlProvider;
}

function access(overrides: Partial<RepositoryAccessResult> = {}): RepositoryAccessResult {
  return {
    repoId: 1,
    repoOwner: "acme",
    repoName: "frontend",
    defaultBranch: "main",
    ...overrides,
  };
}

describe("resolveSessionRepositories", () => {
  it("resolves all entries in order, defaulting baseBranch per entry", async () => {
    const provider = createFakeProvider({
      "acme/frontend": access({ repoId: 1, repoName: "frontend", defaultBranch: "develop" }),
      "acme/backend": access({ repoId: 2, repoName: "backend", defaultBranch: "" }),
    });

    const refs = await resolveSessionRepositories(
      env,
      [
        { repoOwner: "acme", repoName: "frontend", baseBranch: null },
        { repoOwner: "acme", repoName: "backend", baseBranch: "release" },
      ],
      ctx,
      logger,
      provider
    );

    expect(refs).toEqual([
      // No input override → provider default branch.
      { repoOwner: "acme", repoName: "frontend", repoId: 1, baseBranch: "develop" },
      // Input override wins; empty provider default would fall back to "main".
      { repoOwner: "acme", repoName: "backend", repoId: 2, baseBranch: "release" },
    ]);
  });

  it("falls back to main when neither input nor provider names a branch", async () => {
    const provider = createFakeProvider({
      "acme/frontend": access({ defaultBranch: "" }),
    });

    const refs = await resolveSessionRepositories(
      env,
      [{ repoOwner: "acme", repoName: "frontend", baseBranch: null }],
      ctx,
      logger,
      provider
    );

    expect(refs[0].baseBranch).toBe("main");
  });

  it("names every failing repository, 400 when access was cleanly denied", async () => {
    const provider = createFakeProvider({
      "acme/frontend": null,
      "acme/backend": null,
    });

    const error = await resolveSessionRepositories(
      env,
      [
        { repoOwner: "acme", repoName: "frontend", baseBranch: null },
        { repoOwner: "acme", repoName: "backend", baseBranch: null },
      ],
      ctx,
      logger,
      provider
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(400);
    expect((error as HttpError).message).toContain("acme/frontend");
    expect((error as HttpError).message).toContain("acme/backend");
  });

  it("returns 500 when any lookup threw (aggregating with clean denials)", async () => {
    const provider = createFakeProvider({
      "acme/frontend": null,
      "acme/backend": new Error("boom"),
    });

    const error = await resolveSessionRepositories(
      env,
      [
        { repoOwner: "acme", repoName: "frontend", baseBranch: null },
        { repoOwner: "acme", repoName: "backend", baseBranch: null },
      ],
      ctx,
      logger,
      provider
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(500);
    expect((error as HttpError).message).toContain("acme/frontend (not installed");
    expect((error as HttpError).message).toContain("acme/backend (resolution failed)");
  });

  it("rejects entries that resolve to the same canonical repository", async () => {
    // GitLab-style canonicalization: a renamed project redirects, so two
    // requested names can resolve to one repo.
    const canonical = access({ repoId: 7, repoName: "renamed" });
    const provider = createFakeProvider({
      "acme/old-name": canonical,
      "acme/renamed": canonical,
    });

    const error = await resolveSessionRepositories(
      env,
      [
        { repoOwner: "acme", repoName: "old-name", baseBranch: null },
        { repoOwner: "acme", repoName: "renamed", baseBranch: null },
      ],
      ctx,
      logger,
      provider
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(400);
    expect((error as HttpError).message).toContain("resolve to the same repository: acme/renamed");
  });

  it("rejects distinct repositories whose canonical names collide on checkout path", async () => {
    const provider = createFakeProvider({
      "acme/app": access({ repoId: 1, repoOwner: "acme", repoName: "app" }),
      "globex/legacy-app": access({ repoId: 2, repoOwner: "globex", repoName: "app" }),
    });

    const error = await resolveSessionRepositories(
      env,
      [
        { repoOwner: "acme", repoName: "app", baseBranch: null },
        { repoOwner: "globex", repoName: "legacy-app", baseBranch: null },
      ],
      ctx,
      logger,
      provider
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(400);
    expect((error as HttpError).message).toContain("resolve to the same checkout path: app");
  });
});
