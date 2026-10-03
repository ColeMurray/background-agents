import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memorySearchResponseSchema } from "@open-inspect/shared/types/memories";
import { MemoryStore } from "../../src/db/memories";
import { seedMemorySession } from "./memory-test-helpers";
import { SessionMemoryStore } from "../../src/db/session-memories";
import * as searchStore from "../../src/db/memory-search";
import { seedSearchFacts } from "../conformance/memory-search-fixtures";
import { cleanD1Tables } from "./cleanup";
import { initNamedSessionDO, routeRequest, seedActiveUser, seedSandboxAuthHash } from "./helpers";
import {
  assignCustomRole,
  ownershipRequest,
  seedEnvironment,
  seedGrant,
  seedTeam,
} from "./ownership-test-helpers";

const OWNER = "22222222222222222222222222222222";
const OTHER = "33333333333333333333333333333333";
const repo = { repoOwner: "acme/group", repoName: "api", repoId: 123, baseBranch: "main" };
const repositoryScope = {
  type: "repository" as const,
  repoOwner: repo.repoOwner,
  repoName: repo.repoName,
};

/** Create a real indexed session and bind tools to its own sandbox credential. */
async function sandbox(
  id: string,
  options: {
    include?: boolean;
    parent?: string;
    repositories?: (Omit<typeof repo, "repoId"> & { repoId: number | null })[];
    environmentId?: string;
  } = {}
) {
  await seedMemorySession(id, {
    userId: OWNER,
    ownerTeamId: "engineering",
    visibility: "team",
    repositories: options.repositories,
    environmentId: options.environmentId,
    includePersonalMemories: options.include,
    parentSessionId: options.parent,
  });
  const { stub } = await initNamedSessionDO(id);
  await seedSandboxAuthHash(stub, { authToken: `token-${id}`, sandboxId: `sandbox-${id}` });
  return (body: unknown, path = "/search", token = `token-${id}`) =>
    routeRequest(
      new Request(`https://test.local/sessions/${id}/sandbox-memory${path}`, {
        method: path === "/search" ? "POST" : "GET",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        ...(path === "/search" ? { body: JSON.stringify(body) } : {}),
      }),
      env,
      createExecutionContext()
    );
}

describe("session memory discovery", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    await seedActiveUser(OWNER);
    await ownershipRequest("/me/authorization", { as: { userId: OWNER, role: "member" } });
    await assignCustomRole(OWNER, [
      "sessions.create",
      "repositories.use",
      "repositories.read",
      "environments.read",
    ]);
    await seedTeam("engineering", [[OWNER, "member"]]);
    await seedGrant("engineering", {
      repo_id: repo.repoId,
      repo_owner: repo.repoOwner,
      repo_name: repo.repoName,
    });
    await seedEnvironment("dev", "engineering");
  });
  afterEach(() => vi.restoreAllMocks());

  it("discovers an old body match outside a 1,001-fact catalog and reads its body", async () => {
    await seedSearchFacts(env.DB, OWNER, [
      {
        id: "old",
        title: "Billing invariant",
        description: "Webhook processing knowledge",
        content: "Deduplication uses the unique event ID. PRIVATE_BODY_SENTINEL",
        updatedAt: 1,
      },
      ...Array.from({ length: 1000 }, (_, i) => ({ id: `recent_${i}`, updatedAt: i + 2 })),
    ]);
    const call = await sandbox("large-corpus");
    expect(
      (await new SessionMemoryStore(env.DB).load("large-corpus"))!.manifest.items.some(
        (item) => item.memoryId === "old"
      )
    ).toBe(false);
    const response = await call({ query: "billing webhook deduplication" });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain("PRIVATE_BODY_SENTINEL");
    const result = memorySearchResponseSchema.parse(JSON.parse(text));
    expect(result.results.map((record) => record.id)).toEqual(["old"]);
    expect(result.hasMore).toBe(false);
    expect(await (await call(null, "/old")).json()).toMatchObject({
      content: expect.stringContaining("PRIVATE_BODY_SENTINEL"),
    });
  });

  it("ranks title above description above body, uses all terms, and reports bounded results", async () => {
    await seedSearchFacts(env.DB, OWNER, [
      { id: "title", title: "Needle", updatedAt: 1 },
      { id: "description", description: "Needle knowledge", updatedAt: 2 },
      { id: "body", content: "Needle body", updatedAt: 3 },
      { id: "excluded", title: "Needle", status: "proposed" },
      { id: "archived", title: "Needle", status: "archived" },
      { id: "directive", title: "Needle", memoryType: "directive" },
    ]);
    const call = await sandbox("ranking");
    expect(await (await call({ query: "needle", limit: 2 })).json()).toMatchObject({
      results: [{ id: "title" }, { id: "description" }],
      hasMore: true,
    });
    expect(await (await call({ query: "needle missing" })).json()).toEqual({
      results: [],
      hasMore: false,
    });
    expect(await (await call({ query: "needle", limit: 3 })).json()).toMatchObject({
      results: [{ id: "title" }, { id: "description" }, { id: "body" }],
      hasMore: false,
    });
  });

  it("treats wildcard and SQL-shaped text literally and never searches old revisions", async () => {
    await seedSearchFacts(env.DB, OWNER, [
      { id: "literal", content: "Literal %_\\ marker" },
      { id: "ordinary" },
    ]);
    const call = await sandbox("literal");
    expect(await (await call({ query: "%_\\" })).json()).toMatchObject({
      results: [{ id: "literal" }],
      hasMore: false,
    });
    expect(await (await call({ query: "' OR 1=1 --" })).json()).toEqual({
      results: [],
      hasMore: false,
    });
    const store = new MemoryStore(env.DB);
    await store.revise(
      "literal",
      {
        memoryType: "fact",
        title: "Updated knowledge",
        description: "Now describes another fact",
        content: "Replacement body",
      },
      "rev_literal",
      { kind: "user", userId: OWNER, requestId: "revision" }
    );
    expect(await (await call({ query: "%_\\" })).json()).toEqual({ results: [], hasMore: false });
    expect(await (await call({ query: "replacement" })).json()).toMatchObject({
      results: [{ id: "literal", revisionId: expect.not.stringMatching(/^rev_literal$/) }],
    });
  });

  it("searches across permitted scopes and repositories without exposing unrelated matches", async () => {
    const second = { ...repo, repoName: "web", repoId: 456 };
    await seedGrant("engineering", {
      repo_id: 456,
      repo_owner: second.repoOwner,
      repo_name: second.repoName,
    });
    await seedSearchFacts(env.DB, OWNER, [
      { id: "personal", title: "needle" },
      { id: "other-user", title: "needle", ownerUserId: OTHER },
      { id: "api", title: "needle", scope: repositoryScope, repoId: 123 },
      { id: "web", title: "needle", scope: { ...repositoryScope, repoName: "web" }, repoId: 456 },
      { id: "wrong-id", title: "needle", scope: repositoryScope, repoId: 789 },
      { id: "null-id", title: "needle", scope: repositoryScope },
      { id: "environment", title: "needle", scope: { type: "environment", environmentId: "dev" } },
      { id: "other-env", title: "needle", scope: { type: "environment", environmentId: "other" } },
    ]);
    const call = await sandbox("scopes", { repositories: [repo, second], environmentId: "dev" });
    const all = memorySearchResponseSchema.parse(await (await call({ query: "needle" })).json());
    expect(all.results.map((record) => record.id)).toEqual([
      "api",
      "environment",
      "personal",
      "web",
    ]);
    expect(
      await (
        await call({
          query: "needle",
          scope: "repository",
          repoOwner: " ACME/GROUP ",
          repoName: " WEB ",
        })
      ).json()
    ).toMatchObject({ results: [{ id: "web" }], hasMore: false });
    expect(
      await (await call({ query: "needle", scope: "repository", limit: 1 })).json()
    ).toMatchObject({ results: [{ id: "api" }], hasMore: true });
    expect(
      (
        await call({
          query: "needle",
          scope: "repository",
          repoOwner: "acme",
          repoName: "unattached",
        })
      ).status
    ).toBe(403);
    expect((await call({ query: "needle" }, "/search", "token-another-session")).status).toBe(401);
  });

  it("preserves personal opt-out and restricts child discovery to inherited personal pins", async () => {
    await seedSearchFacts(env.DB, OWNER, [{ id: "pinned", title: "needle" }]);
    await sandbox("parent");
    await seedSearchFacts(env.DB, OWNER, [{ id: "later", title: "needle" }]);
    const child = await sandbox("child", { parent: "parent" });
    expect(await (await child({ query: "needle" })).json()).toMatchObject({
      results: [{ id: "pinned" }],
      hasMore: false,
    });
    const excluded = await sandbox("excluded", { include: false });
    expect(await (await excluded({ query: "needle" })).json()).toEqual({
      results: [],
      hasMore: false,
    });
    expect((await excluded({ query: "needle", scope: "personal" })).status).toBe(403);
    expect((await excluded({ query: "needle", scope: "environment" })).status).toBe(403);
  });

  it.each(["before", "during"])(
    "denies repository results when grants are revoked %s search",
    async (when) => {
      await seedSearchFacts(env.DB, OWNER, [
        {
          id: "secret",
          title: "needle",
          description: "PRIVATE_SCOPE_SENTINEL",
          scope: repositoryScope,
          repoId: 123,
        },
      ]);
      const call = await sandbox(`revoked-${when}`, { repositories: [repo] });
      const revoke = () =>
        env.DB.prepare("DELETE FROM team_repository_grants WHERE team_id = 'engineering'").run();
      if (when === "before") await revoke();
      else {
        const original = searchStore.searchMemories;
        vi.spyOn(searchStore, "searchMemories").mockImplementationOnce(async (...args) => {
          const result = await original(...args);
          await revoke();
          return result;
        });
      }
      const response = await call({ query: "needle", scope: "repository" });
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain("PRIVATE_SCOPE_SENTINEL");
    }
  );

  it("rejects malformed searches and does not accept identity overrides", async () => {
    const call = await sandbox("invalid");
    for (const body of [
      { query: " " },
      { query: "x" },
      { query: "x".repeat(257) },
      { query: "one two three four five six seven eight nine" },
      { query: "needle", limit: 21 },
      { query: "needle", limit: 1.5 },
      { query: "needle", ownerUserId: OTHER },
      { query: "needle", environmentId: "other" },
      { query: "needle", scope: "repository", repoOwner: "acme" },
      { query: "needle", repoOwner: "acme", repoName: "api" },
    ])
      expect((await call(body)).status).toBe(400);
  });
  it("accepts the maximum term count within the SQL parameter budget", async () => {
    await seedSearchFacts(env.DB, OWNER, [
      { id: "eight", content: "one two three four five six seven eight" },
    ]);
    const call = await sandbox("eight-terms");
    expect(
      await (await call({ query: "one two three four five six seven eight" })).json()
    ).toMatchObject({ results: [{ id: "eight" }], hasMore: false });
  });
  it("does not authorize a legacy session repository using names alone", async () => {
    await seedSearchFacts(env.DB, OWNER, [
      { id: "legacy-secret", title: "needle", scope: repositoryScope, repoId: 123 },
    ]);
    const call = await sandbox("legacy-scope", { repositories: [{ ...repo, repoId: null }] });
    expect((await call({ query: "needle", scope: "repository" })).status).toBe(403);
  });
  it.each(["environment transfer", "team archive"])(
    "conceals results when %s happens during search",
    async (change) => {
      await seedSearchFacts(env.DB, OWNER, [
        {
          id: "environment-secret",
          title: "needle",
          description: "PRIVATE_ENV_SENTINEL",
          scope: { type: "environment", environmentId: "dev" },
        },
      ]);
      const call = await sandbox(`changed-${change}`, { environmentId: "dev" });
      await seedTeam("other-team");
      const original = searchStore.searchMemories;
      vi.spyOn(searchStore, "searchMemories").mockImplementationOnce(async (...args) => {
        const result = await original(...args);
        await env.DB.prepare(
          change === "environment transfer"
            ? "UPDATE environments SET owner_team_id = 'other-team' WHERE id = 'dev'"
            : "UPDATE teams SET archived_at = 1 WHERE id = 'engineering'"
        ).run();
        return result;
      });
      const response = await call({ query: "needle", scope: "environment" });
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain("PRIVATE_ENV_SENTINEL");
    }
  );
});
