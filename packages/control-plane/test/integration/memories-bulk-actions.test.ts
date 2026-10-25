import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bulkMemoryActionResponseSchema,
  MEMORY_BULK_ACTION_MAX_RECORDS,
} from "@open-inspect/shared/types/memories";
import { EnvironmentStore } from "../../src/db/environments";
import { MemoryRecordStore } from "../../src/db/memory-records";
import { TeamRepositoryGrantStore } from "../../src/db/team-repository-grants";
import { seedSearchFacts } from "../conformance/memory-search-fixtures";
import { cleanD1Tables } from "./cleanup";
import { routeRequest, seedActiveUser, serviceRequestHeaders } from "./helpers";
import {
  assignCustomRole,
  ownershipRequest,
  seedEnvironment,
  seedGrant,
  seedTeam,
} from "./ownership-test-helpers";

const USER = "22222222222222222222222222222222";
const OTHER = "33333333333333333333333333333333";
const managedRepo = { type: "repository" as const, repoId: 101 };
const readableRepo = { type: "repository" as const, repoId: 102 };
const hiddenRepo = { type: "repository" as const, repoId: 103 };
const managedEnv = { type: "environment" as const, environmentId: "managed" };
/** Seeded records' current revision IDs follow the fixture convention. */
const reviewed = (id: string) => ({ id, revisionId: `rev_${id}` });

async function bulk(body: object) {
  return ownershipRequest("/memories/bulk", {
    method: "POST",
    body: JSON.stringify(body),
    as: { userId: USER, role: "member" },
  });
}
async function bulkResults(body: object) {
  const response = await bulk(body);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  return bulkMemoryActionResponseSchema.parse(await response.json()).results;
}
/** Cloudflare's D1 query limit per Worker invocation on the Free plan; a batch counts once. */
const D1_FREE_QUERIES_PER_INVOCATION = 50;

/** Wrap a D1 binding to count the queries a request runs, including authentication's. */
function countingD1(db: D1Database) {
  let count = 0;
  // `batch` must receive the binding's own statements, so remember what each wrapper wraps.
  const originals = new WeakMap<object, D1PreparedStatement>();
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const wrapper = new Proxy(statement, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property === "bind") return (...values: unknown[]) => wrap(target.bind(...values));
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (["first", "run", "all", "raw"].includes(String(property))) count++;
          return value.apply(target, args);
        };
      },
    });
    originals.set(wrapper, statement);
    return wrapper;
  };
  const counted = new Proxy(db, {
    get(target, property) {
      if (property === "prepare") return (query: string) => wrap(target.prepare(query));
      if (property === "batch")
        return (statements: D1PreparedStatement[]) => {
          count++;
          return target.batch(statements.map((statement) => originals.get(statement) ?? statement));
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: counted, count: () => count };
}

const auditedIds = async () =>
  (
    await env.DB.prepare(
      "SELECT resource_id FROM authorization_audit_events WHERE resource_type = 'memory' ORDER BY resource_id"
    ).all<{ resource_id: string }>()
  ).results.map((row) => row.resource_id);

describe("bulk memory lifecycle actions", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    await seedActiveUser(USER);
    await ownershipRequest("/me/authorization", { as: { userId: USER, role: "member" } });
    await assignCustomRole(USER, [
      "memories.manage_own",
      "repositories.read",
      "repositories.settings.manage",
      "environments.read",
      "environments.manage",
      "environments.settings.manage",
    ]);
    await seedTeam("managed", [[USER, "lead"]]);
    await seedTeam("readable", [[USER, "member"]]);
    await seedTeam("hidden");
    for (const [team, repoId] of [
      ["managed", 101],
      ["readable", 102],
      ["hidden", 103],
    ] as const)
      await seedGrant(team, { repo_id: repoId, repo_owner: "acme", repo_name: team });
    await seedEnvironment("managed", "managed");
  });
  afterEach(() => vi.restoreAllMocks());

  it("decides each record independently and reports outcomes in request order", async () => {
    await seedSearchFacts(env.DB, USER, [
      { id: "repo-managed", partition: managedRepo, status: "proposed" },
      { id: "env-managed", partition: managedEnv, status: "proposed" },
      { id: "personal-own", status: "proposed" },
      { id: "repo-readable", partition: readableRepo, status: "proposed" },
      { id: "repo-hidden", partition: hiddenRepo, status: "proposed" },
      { id: "personal-other", partition: { type: "personal", userId: OTHER }, status: "proposed" },
      { id: "stale", partition: managedRepo, status: "proposed" },
    ]);
    const bulkOwners = vi.spyOn(TeamRepositoryGrantStore.prototype, "listOwnersForRepositories");
    const singleOwners = vi.spyOn(TeamRepositoryGrantStore.prototype, "listTeamsForRepository");
    const environments = vi.spyOn(EnvironmentStore.prototype, "getByIds");
    const results = await bulkResults({
      action: "approve",
      memories: [
        reviewed("repo-managed"),
        reviewed("env-managed"),
        reviewed("personal-own"),
        reviewed("repo-readable"),
        reviewed("repo-hidden"),
        reviewed("personal-other"),
        { id: "stale", revisionId: "rev_outdated" },
        reviewed("missing"),
      ],
    });
    expect(results.map((result) => (result.ok ? result.id : [result.id, result.error]))).toEqual([
      "repo-managed",
      "env-managed",
      "personal-own",
      ["repo-readable", "Repository memory management permission required"],
      ["repo-hidden", "Repository grant required"],
      // Another owner's personal record is indistinguishable from a missing one.
      ["personal-other", "Memory not found"],
      ["stale", "Memory changed; reload before acting"],
      ["missing", "Memory not found"],
    ]);
    for (const result of results.filter((entry) => entry.ok))
      expect(result).toMatchObject({
        memory: { status: "active", capabilities: { canEdit: true } },
      });
    // Admission is loaded once for the whole request, not per record.
    expect(bulkOwners).toHaveBeenCalledOnce();
    expect(singleOwners).not.toHaveBeenCalled();
    expect(environments).toHaveBeenCalledOnce();

    const store = new MemoryRecordStore(env.DB);
    for (const id of ["repo-readable", "repo-hidden", "personal-other", "stale"])
      expect((await store.get(id))?.status).toBe("proposed");
    expect(await auditedIds()).toEqual(["env-managed", "personal-own", "repo-managed"]);
  });

  it("archives with one shared note, then restores the same records", async () => {
    await seedSearchFacts(env.DB, USER, [
      { id: "first", partition: managedRepo },
      { id: "second", partition: managedEnv },
    ]);
    const results = await bulkResults({
      action: "archive",
      memories: [reviewed("first"), reviewed("second")],
      archiveNote: " Outdated after the migration ",
    });
    expect(results.every((result) => result.ok)).toBe(true);
    const store = new MemoryRecordStore(env.DB);
    for (const id of ["first", "second"])
      expect(await store.get(id)).toMatchObject({
        status: "archived",
        archiveKind: "manual",
        archiveNote: "Outdated after the migration",
      });
    const restored = await bulkResults({
      action: "restore",
      memories: [reviewed("first"), reviewed("second")],
    });
    expect(restored.map((result) => result.ok)).toEqual([true, true]);
  });

  it("stays within the Workers Free D1 query budget at the largest request", async () => {
    // Approving replacements is the costliest transition: it also reads each predecessor.
    await seedSearchFacts(
      env.DB,
      USER,
      Array.from({ length: MEMORY_BULK_ACTION_MAX_RECORDS }, (_, index) => [
        { id: `old-${index}`, partition: managedRepo },
        { id: `new-${index}`, partition: managedRepo, status: "proposed" as const },
      ]).flat()
    );
    await env.DB.prepare(
      `UPDATE memories SET supersedes_memory_id = 'old-' || substr(id, 5),
        supersedes_revision_id = 'rev_old-' || substr(id, 5) WHERE id LIKE 'new-%'`
    ).run();
    const counter = countingD1(env.DB);
    const url = "https://test.local/memories/bulk";
    const init = {
      method: "POST",
      body: JSON.stringify({
        action: "approve",
        memories: Array.from({ length: MEMORY_BULK_ACTION_MAX_RECORDS }, (_, index) =>
          reviewed(`new-${index}`)
        ),
      }),
      as: { userId: USER, role: "member" as const },
    };
    const response = await routeRequest(
      new Request(url, { ...init, headers: await serviceRequestHeaders(url, init) }),
      { ...env, DB: counter.db },
      createExecutionContext()
    );
    const { results } = bulkMemoryActionResponseSchema.parse(await response.json());
    expect(results.filter((result) => result.ok)).toHaveLength(MEMORY_BULK_ACTION_MAX_RECORDS);
    expect(counter.count()).toBeLessThanOrEqual(D1_FREE_QUERIES_PER_INVOCATION);
  });

  it("rejects malformed requests before touching any record", async () => {
    await seedSearchFacts(env.DB, USER, [{ id: "proposal", status: "proposed" }]);
    const transition = vi.spyOn(MemoryRecordStore.prototype, "transition");
    const tooMany = Array.from({ length: MEMORY_BULK_ACTION_MAX_RECORDS + 1 }, (_, index) =>
      reviewed(`mem_${index}`)
    );
    for (const body of [
      { action: "approve", memories: [] },
      { action: "approve", memories: tooMany },
      { action: "approve", memories: [reviewed("proposal"), reviewed("proposal")] },
      { action: "approve", memories: [reviewed("proposal")], archiveNote: "Not archiving" },
      { action: "delete", memories: [reviewed("proposal")] },
    ])
      expect((await bulk(body)).status).toBe(400);
    expect(transition).not.toHaveBeenCalled();
    expect((await new MemoryRecordStore(env.DB).get("proposal"))?.status).toBe("proposed");
  });
});
