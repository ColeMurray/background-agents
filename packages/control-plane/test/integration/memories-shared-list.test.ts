import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MEMORY_SHARED_LIST_MAX_OFFSET,
  memoryListResponseSchema,
} from "@open-inspect/shared/types/memories";
import { EnvironmentStore } from "../../src/db/environments";
import { MemoryRecordStore } from "../../src/db/memory-records";
import { TeamRepositoryGrantStore } from "../../src/db/team-repository-grants";
import { TeamStore } from "../../src/db/teams";
import { GitHubSourceControlProvider } from "../../src/source-control/providers/github-provider";
import { seedSearchFacts } from "../conformance/memory-search-fixtures";
import { cleanD1Tables } from "./cleanup";
import { seedActiveUser, type ServiceRequestInit } from "./helpers";
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
const readableEnv = { type: "environment" as const, environmentId: "readable" };
const hiddenEnv = { type: "environment" as const, environmentId: "hidden" };
const request = (path: string, init: ServiceRequestInit = {}) =>
  ownershipRequest(path, { ...init, as: { userId: USER, role: "member" } });
async function list(query = "scope=shared") {
  const response = await request(`/memories?${query}`);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  return memoryListResponseSchema.parse(await response.json());
}

describe("shared memory management list", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    await seedActiveUser(USER);
    await request("/me/authorization");
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
    ] as const) {
      await seedGrant(team, { repo_id: repoId, repo_owner: "acme/group", repo_name: team });
      await seedEnvironment(team, team);
    }
    vi.spyOn(GitHubSourceControlProvider.prototype, "checkRepositoryAccess").mockRejectedValue(
      new Error("Shared listing must authorize stable IDs, not resolve display names")
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it("aggregates authorized repositories and environments by stable identity, never personal", async () => {
    const oldScope = { type: "repository" as const, repoOwner: "old/group", repoName: "api" };
    await seedSearchFacts(env.DB, USER, [
      { id: "repo-old-name", partition: managedRepo, scope: oldScope },
      {
        id: "repo-new-name",
        partition: managedRepo,
        scope: { ...oldScope, repoOwner: "new/group" },
      },
      { id: "repo-readable", partition: readableRepo },
      // A different ID reusing the authorized repository's stored name gains no access.
      { id: "repo-hidden", partition: hiddenRepo, scope: oldScope, content: "SECRET_REPO" },
      { id: "env-managed", partition: managedEnv },
      { id: "env-readable", partition: readableEnv },
      { id: "env-hidden", partition: hiddenEnv, content: "SECRET_ENV" },
      { id: "env-missing", partition: { type: "environment", environmentId: "deleted" } },
      { id: "personal-own", content: "SECRET_PERSONAL" },
      { id: "personal-other", partition: { type: "personal", userId: OTHER } },
    ]);
    const query = vi.spyOn(MemoryRecordStore.prototype, "listPartitions");
    const result = await list();
    expect(result.memories.map((record) => record.id)).toEqual([
      "env-managed",
      "env-readable",
      "repo-new-name",
      "repo-old-name",
      "repo-readable",
    ]);
    expect(result.canCreate).toBe(false);
    expect(result.nextOffset).toBeNull();
    const queriedPartitions = query.mock.calls[0][0];
    expect(queriedPartitions).toHaveLength(4);
    expect(queriedPartitions).toEqual(
      expect.arrayContaining([managedRepo, readableRepo, managedEnv, readableEnv])
    );
    expect(GitHubSourceControlProvider.prototype.checkRepositoryAccess).not.toHaveBeenCalled();
    expect((await list("")).memories.map((record) => record.id)).toEqual(["personal-own"]);
    expect((await list("scope=personal")).canCreate).toBe(true);
    expect((await list("scope=environment&environmentId=managed")).canCreate).toBe(true);
  });

  it("computes capabilities per partition and preserves approval authorization", async () => {
    await seedSearchFacts(env.DB, USER, [
      { id: "repo-managed", partition: managedRepo, status: "proposed" },
      { id: "repo-readable", partition: readableRepo, status: "proposed" },
      { id: "env-managed", partition: managedEnv, status: "proposed" },
      { id: "env-readable", partition: readableEnv, status: "proposed" },
      { id: "repo-hidden", partition: hiddenRepo, status: "proposed" },
    ]);
    const proposals = await list("scope=shared&status=proposed");
    expect(proposals.canCreate).toBe(false);
    expect(proposals.memories.map((record) => record.id)).toEqual([
      "env-managed",
      "env-readable",
      "repo-managed",
      "repo-readable",
    ]);
    for (const record of proposals.memories) {
      const canManage = record.id.endsWith("managed");
      expect(record.capabilities).toEqual({
        canEdit: canManage,
        actions: canManage ? ["approve", "reject", "archive"] : [],
      });
      const response = await request(`/memories/${record.id}/approve`, {
        method: "POST",
        body: "{}",
        headers: { "If-Match": record.currentRevisionId },
      });
      expect(response.status).toBe(canManage ? 200 : 403);
    }
    expect((await list()).memories.map((record) => record.id)).toEqual(
      expect.arrayContaining(["env-managed", "repo-managed"])
    );
    expect(
      (await list("scope=shared&status=proposed")).memories.map((record) => record.id)
    ).toEqual(["env-readable", "repo-readable"]);
  });

  it("combines status and literal all-term search with globally stable paging", async () => {
    await seedSearchFacts(env.DB, USER, [
      { id: "a", partition: managedRepo, title: "Needle", content: "100%_done", updatedAt: 30 },
      {
        id: "b",
        partition: managedEnv,
        description: "A NEEDLE description",
        content: "100%_done",
        updatedAt: 30,
      },
      { id: "c", partition: readableRepo, content: "needle 100%_done", updatedAt: 20 },
      { id: "d", partition: readableEnv, content: "needle ordinary", updatedAt: 40 },
      { id: "hidden", partition: hiddenRepo, content: "needle 100%_done", updatedAt: 50 },
      { id: "personal", content: "needle 100%_done", updatedAt: 60 },
      { id: "proposal", partition: managedRepo, title: "needle", status: "proposed" },
      { id: "archived", partition: managedEnv, title: "needle", status: "archived" },
    ]);
    const search = `scope=shared&search=${encodeURIComponent("NEEDLE 100%_")}`;
    const first = await list(`${search}&limit=2`);
    expect(first.memories.map((record) => record.id)).toEqual(["a", "b"]);
    expect(first.nextOffset).toBe(2);
    const second = await list(`${search}&limit=2&offset=${first.nextOffset}`);
    expect(second.memories.map((record) => record.id)).toEqual(["c"]);
    expect(second.nextOffset).toBeNull();
    expect((await list(`${search}&offset=100`)).memories).toEqual([]);
    expect(
      (await list("scope=shared&status=proposed&search=needle")).memories.map((m) => m.id)
    ).toEqual(["proposal"]);
    const archived = await list("scope=shared&status=archived&search=needle");
    expect(archived.memories.map((record) => record.id)).toEqual(["archived"]);
    expect(archived.memories[0].capabilities).toEqual({ canEdit: false, actions: ["restore"] });
    expect((await list("scope=shared&search=%20%20%20")).memories).toHaveLength(4);
    expect((await list("scope=shared&search=missing")).memories).toEqual([]);
  });

  it("bulk authorizes 250 lead repositories and chunks search within D1's parameter budget", async () => {
    await seedGrant("managed", "installation");
    const terms = "one two three four five six seven eight";
    const facts = Array.from({ length: 250 }, (_, index) => ({
      id: `chunk-${String(index).padStart(2, "0")}`,
      partition: { type: "repository" as const, repoId: 1000 + index },
      content: terms,
      updatedAt: index % 3,
    }));
    await seedSearchFacts(env.DB, USER, facts);
    const bulkOwners = vi.spyOn(TeamRepositoryGrantStore.prototype, "listOwnersForRepositories");
    const singleOwners = vi.spyOn(TeamRepositoryGrantStore.prototype, "listTeamsForRepository");
    const teamActivity = vi.spyOn(TeamStore.prototype, "isActive");
    const expected = [...facts]
      .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1))
      .map((record) => record.id);
    const query = `scope=shared&search=${encodeURIComponent(terms)}`;
    const first = await list(`${query}&offset=5&limit=7`);
    expect(bulkOwners).toHaveBeenCalledTimes(1);
    expect(bulkOwners.mock.calls[0][0]).toHaveLength(250);
    expect(singleOwners).not.toHaveBeenCalled();
    expect(teamActivity).not.toHaveBeenCalled();
    expect(first.memories.map((record) => record.id)).toEqual(expected.slice(5, 12));
    expect(first.nextOffset).toBe(12);
    const rest = await list(`${query}&offset=12&limit=100`);
    expect(rest.memories.map((record) => record.id)).toEqual(expected.slice(12, 112));
    expect(rest.nextOffset).toBe(112);
    const last = await list(`${query}&offset=240&limit=100`);
    expect(last.memories.map((record) => record.id)).toEqual(expected.slice(240));
    expect(last.nextOffset).toBeNull();
    expect(rest.canCreate).toBe(false);
  });

  it("bulk admits environment candidates narrowed by status without per-environment reads", async () => {
    const owners = [null, "managed", "readable", "hidden"] as const;
    const facts = Array.from({ length: 250 }, (_, index) => ({
      id: `environment-${String(index).padStart(3, "0")}`,
      partition: { type: "environment" as const, environmentId: `bulk-${index}` },
      status:
        index < 220
          ? ("active" as const)
          : index < 235
            ? ("proposed" as const)
            : ("archived" as const),
      title: index % 5 === 0 ? "Other knowledge" : "Needle",
      content: index % 5 === 0 ? "Not a search match" : "literal 100%_done",
      updatedAt: index,
    }));
    await env.DB.batch(
      facts.map((fact, index) =>
        env.DB.prepare(
          "INSERT INTO environments (id, name, owner_team_id, created_at, updated_at) VALUES (?, ?, ?, 1, 1)"
        ).bind(fact.partition.environmentId, fact.partition.environmentId, owners[index % 4])
      )
    );
    await seedSearchFacts(env.DB, USER, [
      ...facts,
      { id: "deleted", partition: { type: "environment", environmentId: "deleted" } },
    ]);
    const bulk = vi.spyOn(EnvironmentStore.prototype, "getByIds");
    const single = vi.spyOn(EnvironmentStore.prototype, "getById");
    const query = vi.spyOn(MemoryRecordStore.prototype, "listPartitions");
    const actions = {
      active: ["archive"],
      proposed: ["approve", "reject", "archive"],
      archived: ["restore"],
    };
    for (const status of ["active", "proposed", "archived"] as const) {
      for (const search of ["", "NEEDLE 100%_"]) {
        bulk.mockClear();
        query.mockClear();
        const visible = (fact: (typeof facts)[number]) =>
          Number(fact.partition.environmentId.slice(5)) % 4 !== 3;
        // Candidates depend on status alone; search applies only within authorized partitions.
        const candidates = facts.filter((fact) => fact.status === status);
        const expected = candidates.filter(
          (fact) => visible(fact) && (!search || fact.title === "Needle")
        );
        const result = await list(
          `scope=shared&status=${status}&search=${encodeURIComponent(search)}&limit=100`
        );
        expect(bulk).toHaveBeenCalledOnce();
        expect(bulk.mock.calls[0][0]).toEqual(
          expect.arrayContaining(candidates.map((fact) => fact.partition.environmentId))
        );
        expect(bulk.mock.calls[0][0]).toHaveLength(
          candidates.length + (status === "active" ? 1 : 0)
        );
        expect(single).not.toHaveBeenCalled();
        const authorized = candidates.filter(visible).map((fact) => fact.partition);
        expect(query.mock.calls[0][0]).toEqual(expect.arrayContaining(authorized));
        expect(query.mock.calls[0][0]).toHaveLength(authorized.length);
        expect(result.memories.map((record) => record.id)).toEqual(
          [...expected]
            .reverse()
            .slice(0, 100)
            .map((fact) => fact.id)
        );
        for (const record of result.memories) {
          if (record.scope.type !== "environment") throw new Error("Expected environment scope");
          const index = Number(record.scope.environmentId.slice(5));
          const canManage = index % 4 <= 1;
          expect(record.capabilities.canEdit).toBe(canManage && status !== "archived");
          expect(record.capabilities.actions).toEqual(canManage ? actions[status] : []);
        }
      }
    }
  });

  it.each([
    ["repositories.read", "env-managed"],
    ["environments.read", "repo-managed"],
  ])("omits scopes without %s instead of denying the aggregate", async (permission, remaining) => {
    await seedSearchFacts(env.DB, USER, [
      { id: "repo-managed", partition: managedRepo },
      { id: "env-managed", partition: managedEnv },
    ]);
    await env.DB.prepare("DELETE FROM role_permissions WHERE role_id = ? AND permission_id = ?")
      .bind(`role_custom_${USER}`, permission)
      .run();
    expect((await list()).memories.map((record) => record.id)).toEqual([remaining]);
  });

  it("bounds shared offsets and never advertises a page beyond the cap", async () => {
    await seedSearchFacts(env.DB, USER, [
      { id: "first", partition: managedRepo },
      { id: "second", partition: managedRepo },
    ]);
    const store = new MemoryRecordStore(env.DB);
    const records = [(await store.get("first"))!, (await store.get("second"))!];
    const pages = vi
      .spyOn(MemoryRecordStore.prototype, "listPartitions")
      .mockResolvedValue(records);
    const last = await list(`scope=shared&offset=${MEMORY_SHARED_LIST_MAX_OFFSET}&limit=1`);
    expect(last.memories).toHaveLength(1);
    expect(last.nextOffset).toBeNull();
    expect(last.truncated).toBe(true);
    expect(pages.mock.calls[0][1]).toMatchObject({
      offset: MEMORY_SHARED_LIST_MAX_OFFSET,
      limit: 2,
    });
    expect(
      await list(`scope=shared&offset=${MEMORY_SHARED_LIST_MAX_OFFSET - 1}&limit=1`)
    ).toMatchObject({ nextOffset: MEMORY_SHARED_LIST_MAX_OFFSET, truncated: false });
    // The final page is not truncated when nothing remains past it.
    pages.mockResolvedValueOnce(records.slice(0, 1));
    expect(
      await list(`scope=shared&offset=${MEMORY_SHARED_LIST_MAX_OFFSET}&limit=1`)
    ).toMatchObject({ nextOffset: null, truncated: false });
    pages.mockClear();
    expect(
      (await request(`/memories?scope=shared&offset=${MEMORY_SHARED_LIST_MAX_OFFSET + 1}`)).status
    ).toBe(400);
    expect(pages).not.toHaveBeenCalled();
    pages.mockRestore();
    expect(
      (await list(`scope=personal&offset=${MEMORY_SHARED_LIST_MAX_OFFSET + 1}`)).memories
    ).toEqual([]);
  });

  it("returns an empty non-creatable aggregate and retains request validation", async () => {
    expect(await list()).toEqual({
      memories: [],
      nextOffset: null,
      truncated: false,
      canCreate: false,
    });
    for (const query of [
      "scope=invalid",
      "scope=shared&status=invalid",
      "scope=shared&offset=-1",
      "scope=shared&limit=101",
      "scope=shared&limit=0",
      "scope=shared&search=a",
      `scope=shared&search=${"x".repeat(257)}`,
      "scope=shared&search=one%20two%20three%20four%20five%20six%20seven%20eight%20nine",
    ])
      expect((await request(`/memories?${query}`)).status).toBe(400);
  });
});
