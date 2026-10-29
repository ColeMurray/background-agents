import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestBackgroundTasks } from "../background-tasks.test-support";
import { createRequestMetrics } from "../db/instrumented-sql-database";
import { branchesCacheKey, cachedBranchesListSchema, listBranchesWithCache } from "./branch-cache";

const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("../logger", () => ({ createLogger: () => logger }));

const entry = {
  branches: [{ name: "main" }],
  cachedAt: "2026-01-01T00:00:00.000Z",
  scmIdentity: "installation-identity",
  freshUntil: 1_767_225_660_000,
};

describe("branch cache", () => {
  it("uses a versioned, case-insensitive repository key and retains nested owners", () => {
    expect(branchesCacheKey("Acme", "Widgets")).toBe("repos:branches:v1:acme/widgets");
    expect(branchesCacheKey("Acme/Platform", "Widgets")).toBe(
      "repos:branches:v1:acme/platform/widgets"
    );
    expect(branchesCacheKey("acme", "other")).not.toBe(branchesCacheKey("acme", "widgets"));
  });

  it("validates populated and empty branch lists", () => {
    expect(cachedBranchesListSchema.parse(entry)).toEqual(entry);
    expect(cachedBranchesListSchema.parse({ ...entry, branches: [] }).branches).toEqual([]);
  });

  it.each([
    null,
    { ...entry, branches: [{ name: 42 }] },
    { ...entry, branches: [{}] },
    { ...entry, cachedAt: undefined },
    { ...entry, scmIdentity: undefined },
    { ...entry, freshUntil: undefined },
    { ...entry, freshUntil: "later" },
  ])("rejects malformed cache entries (%j)", (value) => {
    expect(cachedBranchesListSchema.safeParse(value).success).toBe(false);
  });
});

describe("provider branch cache policy", () => {
  const now = Date.parse("2026-01-01T00:00:00.000Z");
  const repository = { owner: "acme", name: "widgets" };
  const branches = [{ name: "main" }, { name: "feature/widgets" }];
  const store = { get: vi.fn(), put: vi.fn(), delete: vi.fn() };
  const cache = { store, getIdentity: vi.fn() };
  const fetchBranches = vi.fn();
  const context = () => ({
    backgroundTasks: createTestBackgroundTasks(),
    metrics: createRequestMetrics(),
    traceId: "trace-1",
  });
  const cachedEntry = (freshUntil = now + 60_000) => ({
    branches,
    cachedAt: new Date(now).toISOString(),
    scmIdentity: "scm-1",
    freshUntil,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    store.get.mockResolvedValue(null);
    store.put.mockResolvedValue(undefined);
    cache.getIdentity.mockResolvedValue("scm-1");
    fetchBranches.mockResolvedValue(branches);
  });

  afterEach(() => vi.useRealTimers());

  it("fills a miss once, keeps the write alive, and measures cache and SCM work", async () => {
    const ctx = context();
    let resolve!: (value: { name: string }[]) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((done) => (markStarted = done));
    fetchBranches.mockImplementation(() => {
      markStarted();
      return new Promise<{ name: string }[]>((done) => (resolve = done));
    });
    const pending = listBranchesWithCache(
      { owner: "Acme", name: "Widgets" },
      fetchBranches,
      ctx,
      cache
    );
    await started;
    expect(ctx.backgroundTasks.submissions).toHaveLength(1);
    expect(store.put).not.toHaveBeenCalled();
    resolve(branches);
    await ctx.backgroundTasks.settle();

    await expect(pending).resolves.toEqual({
      branches,
      cached: false,
      cachedAt: new Date(now).toISOString(),
    });
    expect(fetchBranches).toHaveBeenCalledOnce();
    expect(store.get).toHaveBeenCalledExactlyOnceWith("repos:branches:v1:acme/widgets", "json");
    expect(store.put).toHaveBeenCalledExactlyOnceWith(
      "repos:branches:v1:acme/widgets",
      JSON.stringify(cachedEntry()),
      { ttlMs: 3_600_000 }
    );
    expect(ctx.backgroundTasks.submissions[0].name).toBe("repos_branches_cache.refresh");
    expect(ctx.backgroundTasks.failures).toEqual([]);
    expect(ctx.metrics.summarize()).toMatchObject({ kv_read_ms: 0, scm_api_ms: 0 });
  });

  it("serves a subsequent request from cache throughout the fresh window", async () => {
    store.put.mockImplementation(async (_key, value: string) =>
      store.get.mockResolvedValue(JSON.parse(value))
    );
    await listBranchesWithCache(repository, fetchBranches, context(), cache);
    fetchBranches.mockClear();
    vi.setSystemTime(now + 59_999);
    const ctx = context();

    await expect(listBranchesWithCache(repository, fetchBranches, ctx, cache)).resolves.toEqual({
      branches,
      cached: true,
      cachedAt: new Date(now).toISOString(),
    });
    expect(fetchBranches).not.toHaveBeenCalled();
    expect(ctx.backgroundTasks.submissions).toHaveLength(0);
    expect(ctx.metrics.summarize()).toHaveProperty("kv_read_ms");
    expect(ctx.metrics.summarize()).not.toHaveProperty("scm_api_ms");
  });

  it("serves stale data immediately and reports deferred refresh timing independently", async () => {
    store.get.mockResolvedValue(cachedEntry(now));
    const ctx = context();
    let resolve!: (value: { name: string }[]) => void;
    fetchBranches.mockReturnValue(new Promise<{ name: string }[]>((done) => (resolve = done)));

    await expect(listBranchesWithCache(repository, fetchBranches, ctx, cache)).resolves.toEqual({
      branches,
      cached: true,
      cachedAt: new Date(now).toISOString(),
    });
    expect(ctx.backgroundTasks.submissions).toHaveLength(1);
    expect(store.put).not.toHaveBeenCalled();
    expect(ctx.metrics.summarize()).not.toHaveProperty("scm_api_ms");
    expect(logger.info).not.toHaveBeenCalled();
    vi.setSystemTime(now + 250);
    resolve([{ name: "new-branch" }]);
    await ctx.backgroundTasks.settle();

    expect(JSON.parse(store.put.mock.calls[0][1])).toMatchObject({
      branches: [{ name: "new-branch" }],
      freshUntil: now + 250 + 60_000,
    });
    expect(logger.info).toHaveBeenCalledExactlyOnceWith("repos_branches_cache.fetch", {
      event: "repos_branches_cache.fetch",
      trace_id: "trace-1",
      repo_owner: "acme",
      repo_name: "widgets",
      scm_api_ms: 250,
    });
  });

  it.each(["cold", "stale"])(
    "coalesces concurrent %s refreshes and releases completed work",
    async (state) => {
      if (state === "stale") store.get.mockResolvedValue(cachedEntry(now));
      let resolve!: (value: { name: string }[]) => void;
      fetchBranches.mockReturnValue(new Promise<{ name: string }[]>((done) => (resolve = done)));
      const contexts = [context(), context()];
      const pending = contexts.map((ctx, index) =>
        listBranchesWithCache(
          index ? { owner: "Acme", name: "Widgets" } : repository,
          fetchBranches,
          ctx,
          cache
        )
      );
      try {
        await vi.waitFor(() =>
          contexts.forEach((ctx) => expect(ctx.backgroundTasks.submissions).toHaveLength(1))
        );
        expect(fetchBranches).toHaveBeenCalledOnce();
        expect(store.put).not.toHaveBeenCalled();
        if (state === "stale") {
          for (const result of await Promise.all(pending)) expect(result.cached).toBe(true);
        }
      } finally {
        resolve(branches);
        await Promise.all(contexts.map((ctx) => ctx.backgroundTasks.settle()));
        await Promise.all(pending);
      }
      expect(store.put).toHaveBeenCalledOnce();
      fetchBranches.mockResolvedValue(branches);
      const retry = context();
      await listBranchesWithCache(repository, fetchBranches, retry, cache);
      await retry.backgroundTasks.settle();
      expect(fetchBranches).toHaveBeenCalledTimes(2);
    }
  );

  it.each(["repository", "SCM identity"])(
    "does not coalesce different %s values",
    async (scope) => {
      let resolve!: (value: { name: string }[]) => void;
      fetchBranches.mockReturnValue(new Promise<{ name: string }[]>((done) => (resolve = done)));
      const contexts = [context(), context()];
      const pending = [
        listBranchesWithCache(repository, fetchBranches, contexts[0], cache),
        listBranchesWithCache(
          scope === "repository" ? { ...repository, name: "other" } : repository,
          fetchBranches,
          contexts[1],
          scope === "SCM identity" ? { store, getIdentity: async () => "scm-2" } : cache
        ),
      ];
      try {
        await vi.waitFor(() =>
          contexts.forEach((ctx) => expect(ctx.backgroundTasks.submissions).toHaveLength(1))
        );
        expect(fetchBranches).toHaveBeenCalledTimes(2);
      } finally {
        resolve(branches);
        await Promise.all(contexts.map((ctx) => ctx.backgroundTasks.settle()));
        await Promise.all(pending);
      }
      expect(store.put).toHaveBeenCalledTimes(2);
    }
  );

  it("releases rejected refreshes so later requests can retry", async () => {
    const failure = new Error("Provider unavailable");
    fetchBranches.mockRejectedValue(failure);
    const ctx = context();
    await expect(listBranchesWithCache(repository, fetchBranches, ctx, cache)).rejects.toBe(
      failure
    );
    await ctx.backgroundTasks.settle();
    expect(store.put).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      "repos_branches_cache.fetch",
      expect.objectContaining({ scm_api_ms: 0 })
    );
    fetchBranches.mockResolvedValue(branches);
    await expect(
      listBranchesWithCache(repository, fetchBranches, context(), cache)
    ).resolves.toMatchObject({ cached: false });
    expect(fetchBranches).toHaveBeenCalledTimes(2);
    expect(store.put).toHaveBeenCalledOnce();
  });

  it.each([
    { label: "a mismatched identity", value: () => ({ ...cachedEntry(), scmIdentity: "scm-2" }) },
    { label: "a malformed entry", value: () => ({ ...cachedEntry(), branches: [{ name: 42 }] }) },
  ])("treats $label as a miss", async ({ value }) => {
    store.get.mockResolvedValue(value());
    await expect(
      listBranchesWithCache(repository, fetchBranches, context(), cache)
    ).resolves.toMatchObject({ cached: false, branches });
    expect(fetchBranches).toHaveBeenCalledOnce();
    expect(JSON.parse(store.put.mock.calls[0][1]).scmIdentity).toBe("scm-1");
  });

  it("preserves stale data and warns when its refresh fails", async () => {
    store.get.mockResolvedValue(cachedEntry(now));
    const failure = new Error("Provider unavailable");
    fetchBranches.mockRejectedValue(failure);
    const ctx = context();
    await expect(
      listBranchesWithCache(repository, fetchBranches, ctx, cache)
    ).resolves.toMatchObject({ cached: true, branches });
    await ctx.backgroundTasks.settle();
    expect(logger.warn).toHaveBeenCalledWith(
      "Failed to refresh branches cache",
      expect.objectContaining({ error: failure })
    );
    expect(store.put).not.toHaveBeenCalled();
    expect(store.delete).not.toHaveBeenCalled();
  });

  it.each(["read", "write"])("tolerates cache %s failures", async (operation) => {
    store[operation === "read" ? "get" : "put"].mockRejectedValue(new Error("Cache unavailable"));
    await expect(
      listBranchesWithCache(repository, fetchBranches, context(), cache)
    ).resolves.toMatchObject({ cached: false, branches });
    expect(logger.warn).toHaveBeenCalled();
  });
});
