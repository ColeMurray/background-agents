import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCloudflareEnv } from "../../src/cloudflare/platform";
import { handleControlPlaneHttp } from "../../src/cloudflare/http-host";
import { SessionCollaboratorStore } from "../../src/db/session-collaborators";
import { SessionIndexStore, type SessionEntry } from "../../src/db/session-index";
import { TeamMembershipStore } from "../../src/db/team-memberships";
import { TeamStore } from "../../src/db/teams";
import { SessionInternalPaths } from "../../src/session/contracts";
import { cleanD1Tables } from "./cleanup";
import {
  initNamedSessionDO,
  queryDO,
  seedActiveUser,
  seedMessage,
  seedSandboxAuth,
  serviceRequestHeaders,
  TEST_SESSION_PROVIDER_AUTH,
} from "./helpers";

const BASE = "https://test.local";
const ACTOR = "11111111111111111111111111111111";
const OTHER_OWNER = "22222222222222222222222222222222";
const AUTHOR = "33333333333333333333333333333333";

async function session(id: string, overrides: Partial<SessionEntry> = {}) {
  await new SessionIndexStore(env.DB).create({
    id,
    ownerTeamId: null,
    visibility: "workspace",
    title: id,
    repoOwner: "acme",
    repoName: "web-app",
    baseBranch: "main",
    model: "anthropic/claude-haiku-4-5",
    reasoningEffort: null,
    status: "active",
    userId: ACTOR,
    providerAuth: TEST_SESSION_PROVIDER_AUTH,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  });
}

async function descendants(rootId: string, count: number, overrides: Partial<SessionEntry> = {}) {
  const ids = Array.from({ length: count }, (_, index) => `${rootId}-descendant-${index}`);
  for (const [index, id] of ids.entries()) {
    await session(id, {
      ...overrides,
      // A branching tree exercises grandchildren without exceeding the cancellation depth cap.
      parentSessionId: index === 0 ? rootId : ids[Math.floor((index - 1) / 2)],
    });
  }
  return ids;
}

async function sandboxParent(id: string, overrides: Partial<SessionEntry> = {}, withAuthor = true) {
  await session(id, overrides);
  const { stub } = await initNamedSessionDO(id, {
    userId: "slack:U_BATCH_AUTHOR",
    canonicalUserId: AUTHOR,
  });
  const token = `sandbox-token-${id}`;
  await seedSandboxAuth(stub, { authToken: token, sandboxId: `sandbox-${id}` });
  if (withAuthor) {
    const [owner] = await queryDO<{ id: string }>(
      stub,
      "SELECT id FROM participants WHERE role = 'owner'"
    );
    if (!owner) throw new Error("Expected sandbox parent owner");
    await seedMessage(stub, {
      id: `processing-${id}`,
      authorId: owner.id,
      content: "Work on the children",
      source: "web",
      status: "processing",
      createdAt: Date.now(),
      startedAt: Date.now(),
    });
  }
  return token;
}

function readCounts(statements: readonly string[]) {
  // Count actual D1 statement preparations, not batch RPCs. UPDATEs and INSERT ... SELECT
  // operation audits are writes and necessarily scale with the number of changed rows.
  const selects = statements.filter((sql) => /^(SELECT|WITH)\b/i.test(sql));
  const count = (pattern: RegExp) => selects.filter((sql) => pattern.test(sql)).length;
  return {
    totalSelects: selects.length,
    sessionGets: count(/^SELECT \* FROM sessions WHERE id = \?$/),
    sessionBatches: count(/^SELECT \* FROM sessions WHERE id IN \(/),
    memberships: count(/^SELECT team_id, role FROM team_memberships WHERE user_id = \?$/),
    collaboratorGets: count(/FROM session_collaborators WHERE session_id = \?$/),
    collaboratorBatches: count(/FROM session_collaborators WHERE session_id IN \(/),
    authorizationReads: count(/FROM users u LEFT JOIN user_role_assignments ura/),
    descendantLists: count(/^WITH RECURSIVE descendants\b/),
  };
}

async function measuredRequest(
  path: string,
  options: { method?: string; body?: object; sandboxToken?: string } = {}
) {
  const url = `${BASE}${path}`;
  const method = options.method ?? "GET";
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  // Credential seeding and fixture reads must stay outside the measured request.
  const headers = options.sandboxToken
    ? { Authorization: `Bearer ${options.sandboxToken}`, "Content-Type": "application/json" }
    : await serviceRequestHeaders(url, { method, body, as: { userId: ACTOR, role: "member" } });
  const appEnv = createCloudflareEnv({ ...env, TEAMS_ENFORCEMENT: "on" });
  const dispatch = appEnv.SESSION;
  const runtimeCalls: Array<{ sessionId: string; path: string }> = [];
  appEnv.SESSION = async (sessionId, request) => {
    const internalPath = new URL(request.url).pathname;
    runtimeCalls.push({ sessionId, path: internalPath });
    // Runtime cancellation is covered by child-session-ops. Keep its required O(N)
    // dispatches separate from the real D1 authorization reads under regression here.
    if (internalPath === SessionInternalPaths.cancel) {
      expect(request.method).toBe("POST");
      return Response.json({ status: "cancelled" });
    }
    return dispatch(sessionId, request);
  };
  // The request's instrumented SQL adapter delegates to this exact injected D1 binding.
  const prepare = vi.spyOn(appEnv.DB, "prepare");
  const get = vi.spyOn(SessionIndexStore.prototype, "get");
  const getByIds = vi.spyOn(SessionIndexStore.prototype, "getByIds");
  const listForSessions = vi.spyOn(SessionCollaboratorStore.prototype, "listForSessions");
  const executionCtx = createExecutionContext();
  try {
    const response = await handleControlPlaneHttp(
      new Request(url, { method, headers, body }),
      appEnv,
      executionCtx
    );
    await waitOnExecutionContext(executionCtx);
    const statements = prepare.mock.calls.map(([sql]) => sql.replace(/\s+/g, " ").trim());
    return {
      response,
      statements,
      reads: readCounts(statements),
      sessionGets: get.mock.calls.map(([id]) => id),
      sessionBatches: getByIds.mock.calls.map(([ids]) => [...ids]),
      collaboratorBatches: listForSessions.mock.calls.map(([ids]) => [...ids]),
      cancelledIds: runtimeCalls
        .filter(({ path }) => path === SessionInternalPaths.cancel)
        .map(({ sessionId }) => sessionId),
      authorResolutions: runtimeCalls.filter(
        ({ path }) => path === SessionInternalPaths.activePromptAuthor
      ).length,
    };
  } finally {
    prepare.mockRestore();
    get.mockRestore();
    getByIds.mockRestore();
    listForSessions.mockRestore();
  }
}

describe("session descendant authorization batching (real D1)", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    await serviceRequestHeaders(`${BASE}/me/authorization`, {
      as: { userId: ACTOR, role: "member" },
    });
    await seedActiveUser(OTHER_OWNER);
    await seedActiveUser(AUTHOR);
  });

  afterEach(() => vi.restoreAllMocks());

  it("keeps visibility authorization SELECTs constant for 1 and 20 descendants and reuses admitted rows", async () => {
    const counts = [];
    for (const size of [1, 20]) {
      const root = `visibility-${size}`;
      await session(root);
      const ids = [root, ...(await descendants(root, size))];
      const result = await measuredRequest(`/sessions/${root}/visibility`, {
        method: "PUT",
        body: { visibility: "private" },
      });
      expect(result.response.status).toBe(200);
      const body = await result.response.json<{ affectedSessionIds: string[] }>();
      expect(body.affectedSessionIds.sort()).toEqual([...ids].sort());
      expect(result.reads).toMatchObject({
        sessionGets: 1,
        sessionBatches: 1,
        memberships: 1,
        collaboratorGets: 1,
        collaboratorBatches: 1,
        authorizationReads: 1,
        descendantLists: 1,
      });
      expect(result.sessionGets).toEqual([root]);
      expect(result.sessionBatches).toHaveLength(1);
      expect(result.sessionBatches[0].sort()).toEqual(ids.slice(1).sort());
      expect(result.collaboratorBatches).toHaveLength(1);
      expect(result.collaboratorBatches[0].sort()).toEqual(ids.slice(1).sort());
      counts.push(result.reads);

      // These writes are intentionally O(N), independently of the SELECT budget.
      expect(
        result.statements.filter((sql) => sql.startsWith("UPDATE sessions SET visibility"))
      ).toHaveLength(ids.length);
      const rows = await new SessionIndexStore(env.DB).getByIds(ids);
      expect([...rows.values()].map((row) => row.visibility)).toEqual(ids.map(() => "private"));
      const audits = await env.DB.prepare(
        `SELECT resource_id FROM authorization_audit_events
         WHERE request_id = ? AND action = 'session.visibility_changed'`
      )
        .bind(result.response.headers.get("x-request-id"))
        .all<{ resource_id: string }>();
      expect(audits.results.map((row) => row.resource_id).sort()).toEqual([...ids].sort());
    }
    expect(counts[1]).toEqual(counts[0]);
  });

  it.each(["human", "sandbox"] as const)(
    "keeps %s cancel-cascade authorization SELECTs constant while runtime calls scale with descendants",
    async (caller) => {
      const counts = [];
      for (const size of [1, 20]) {
        const parent = `${caller}-cancel-${size}-${crypto.randomUUID()}`;
        const token = caller === "sandbox" ? await sandboxParent(parent) : undefined;
        if (caller === "human") await session(parent);
        const child = `${parent}-child`;
        const privateScope = { visibility: "private", userId: OTHER_OWNER } as const;
        await session(child, { ...privateScope, parentSessionId: parent });
        const ids = await descendants(child, size, privateScope);
        const collaborators = new SessionCollaboratorStore(env.DB);
        for (const id of [child, ...ids]) {
          await collaborators.add(id, caller === "sandbox" ? AUTHOR : ACTOR, OTHER_OWNER);
        }
        const result = await measuredRequest(`/sessions/${parent}/children/${child}/cancel`, {
          method: "POST",
          sandboxToken: token,
        });
        expect(result.response.status).toBe(200);
        const body = await result.response.json<{
          status: string;
          cancelledDescendantIds: string[];
        }>();
        expect(body.status).toBe("cancelled");
        expect(body.cancelledDescendantIds.sort()).toEqual([...ids].sort());
        expect(result.cancelledIds[0]).toBe(child);
        expect(result.cancelledIds).toHaveLength(size + 1);
        expect([...result.cancelledIds].sort()).toEqual([child, ...ids].sort());
        expect(result.reads).toMatchObject({
          sessionBatches: 1,
          memberships: 1,
          collaboratorGets: caller === "human" ? 2 : 1,
          collaboratorBatches: 1,
          authorizationReads: 1,
          descendantLists: 1,
        });
        expect(result.sessionGets.length).toBeLessThanOrEqual(2);
        expect(result.sessionGets.every((id) => id === parent || id === child)).toBe(true);
        if (caller === "human") expect(result.sessionGets).toEqual([parent, child]);
        expect(result.sessionBatches).toHaveLength(1);
        expect(result.sessionBatches[0].sort()).toEqual([...ids].sort());
        expect(result.collaboratorBatches).toHaveLength(1);
        expect(result.collaboratorBatches[0].sort()).toEqual([...ids].sort());
        expect(result.authorResolutions).toBe(caller === "sandbox" ? 1 : 0);
        counts.push(result.reads);
      }
      expect(counts[1]).toEqual(counts[0]);
    }
  );

  it.each(["human", "sandbox"] as const)(
    "preflights every private descendant before dispatching any %s cancellation",
    async (caller) => {
      const parent = `denied-${caller}-${crypto.randomUUID()}`;
      const token = caller === "sandbox" ? await sandboxParent(parent) : undefined;
      if (caller === "human") await session(parent);
      const child = `${parent}-child`;
      const privateScope = { visibility: "private", userId: OTHER_OWNER } as const;
      await session(child, { ...privateScope, parentSessionId: parent });
      const ids = await descendants(child, 20, privateScope);
      const collaborators = new SessionCollaboratorStore(env.DB);
      for (const id of [child, ...ids.slice(0, -1)]) {
        await collaborators.add(id, caller === "sandbox" ? AUTHOR : ACTOR, OTHER_OWNER);
      }
      const result = await measuredRequest(`/sessions/${parent}/children/${child}/cancel`, {
        method: "POST",
        sandboxToken: token,
      });
      expect(result.response.status).toBe(404);
      expect(await result.response.json()).toEqual({ error: "Child session not found" });
      expect(result.cancelledIds).toEqual([]);
      expect(result.reads).toMatchObject({
        sessionBatches: 1,
        memberships: 1,
        collaboratorBatches: 1,
      });
      const rows = await new SessionIndexStore(env.DB).getByIds([child, ...ids]);
      expect([...rows.values()].every((row) => row.status === "active")).toBe(true);
    }
  );

  it("bulk-loads sandbox child collaborators and resolves the canonical author once for 1 and 20 private children", async () => {
    const team = await new TeamStore(env.DB).create({
      slug: "batch-author",
      name: "Batch author",
      joinPolicy: "invite_only",
    });
    const otherTeam = await new TeamStore(env.DB).create({
      slug: "batch-other",
      name: "Other team",
      joinPolicy: "invite_only",
    });
    await new TeamMembershipStore(env.DB).add(team.id, AUTHOR);
    const counts = [];
    for (const size of [1, 20]) {
      const parent = `sandbox-list-${size}-${crypto.randomUUID()}`;
      const token = await sandboxParent(parent, { ownerTeamId: team.id, visibility: "team" });
      const selectedIds: string[] = [];
      const visibleIds: string[] = [];
      for (let index = 0; index < size; index++) {
        const id = `${parent}-private-${index}`;
        await session(id, {
          parentSessionId: parent,
          ownerTeamId: team.id,
          visibility: "private",
          userId: index % 3 === 1 ? AUTHOR : OTHER_OWNER,
        });
        selectedIds.push(id);
        if (index % 3 === 0) {
          await new SessionCollaboratorStore(env.DB).add(id, AUTHOR, OTHER_OWNER);
        }
        if (index % 3 !== 2) visibleIds.push(id);
      }
      for (const visibility of ["workspace", "team"] as const) {
        const id = `${parent}-${visibility}`;
        await session(id, { parentSessionId: parent, ownerTeamId: team.id, visibility });
        selectedIds.push(id);
        visibleIds.push(id);
      }
      const movedId = `${parent}-moved`;
      await session(movedId, { parentSessionId: parent, ownerTeamId: otherTeam.id });
      selectedIds.push(movedId);
      const result = await measuredRequest(`/sessions/${parent}/children`, { sandboxToken: token });
      expect(result.response.status).toBe(200);
      const body = await result.response.json<{ children: Array<{ id: string }> }>();
      expect(body.children.map(({ id }) => id).sort()).toEqual(visibleIds.sort());
      expect(result.reads).toMatchObject({
        sessionGets: 1,
        sessionBatches: 0,
        memberships: 1,
        collaboratorGets: 0,
        collaboratorBatches: 1,
        authorizationReads: 1,
        descendantLists: 0,
      });
      expect(result.sessionGets).toEqual([parent]);
      expect(result.collaboratorBatches).toHaveLength(1);
      expect(result.collaboratorBatches[0].sort()).toEqual(selectedIds.sort());
      expect(result.authorResolutions).toBe(1);
      counts.push(result.reads);
    }
    expect(counts[1]).toEqual(counts[0]);
  });

  it.each(["workspace", "team"] as const)(
    "retains the sandbox %s read shortcut without resolving an active author",
    async (visibility) => {
      const team = await new TeamStore(env.DB).create({
        slug: "shortcut",
        name: "Shortcut",
        joinPolicy: "invite_only",
      });
      const parent = `shortcut-${visibility}-${crypto.randomUUID()}`;
      const ownerTeamId = visibility === "team" ? team.id : null;
      const token = await sandboxParent(parent, { ownerTeamId, visibility }, false);
      const ids = Array.from({ length: 20 }, (_, index) => `${parent}-child-${index}`);
      for (const id of ids) {
        await session(id, { parentSessionId: parent, ownerTeamId, visibility });
      }
      const result = await measuredRequest(`/sessions/${parent}/children`, { sandboxToken: token });
      expect(result.response.status).toBe(200);
      const body = await result.response.json<{ children: Array<{ id: string }> }>();
      expect(body.children.map(({ id }) => id).sort()).toEqual(ids.sort());
      expect(result.authorResolutions).toBe(0);
      expect(result.reads).toMatchObject({
        sessionGets: 1,
        memberships: 0,
        collaboratorGets: 0,
        authorizationReads: 0,
      });
      expect(result.reads.collaboratorBatches).toBeLessThanOrEqual(1);
    }
  );

  it("keeps the empty sandbox child-list shortcut free of parent and authorization reads", async () => {
    const parent = `empty-list-${crypto.randomUUID()}`;
    const token = await sandboxParent(parent, {}, false);
    const result = await measuredRequest(`/sessions/${parent}/children`, { sandboxToken: token });
    expect(result.response.status).toBe(200);
    expect(await result.response.json()).toEqual({ children: [] });
    expect(result.authorResolutions).toBe(0);
    expect(result.reads).toMatchObject({
      sessionGets: 0,
      sessionBatches: 0,
      memberships: 0,
      collaboratorGets: 0,
      collaboratorBatches: 0,
      authorizationReads: 0,
    });
  });
});
