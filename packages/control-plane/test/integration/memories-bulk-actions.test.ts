import { env } from "cloudflare:test";
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
import { seedActiveUser } from "./helpers";
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
      { id: "already-active", partition: managedRepo },
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
        reviewed("already-active"),
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
      ["already-active", "Memory status changed; reload before acting"],
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
