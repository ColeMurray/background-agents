import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_ACTIONS, type SessionAction } from "@open-inspect/shared";
import {
  BUILT_IN_ROLE_KEYS,
  BUILT_IN_ROLE_REGISTRY,
  permissionsForBuiltInRole,
  type BuiltInRoleKey,
} from "@open-inspect/shared/rbac";
import type { SessionVisibility, TeamRole } from "@open-inspect/shared/types/teams";
import { createTestBackgroundTasks } from "../background-tasks.test-support";
import { createRequestMetrics } from "../db/instrumented-sql-database";
import { MAX_D1_QUERY_PARAMETERS } from "../db/query-limits";
import { SessionCollaboratorStore } from "../db/session-collaborators";
import { SessionIndexStore, type SessionEntry } from "../db/session-index";
import { toSessionFields } from "../db/session-row";
import type { SqlDatabase, SqlStatement } from "../db/sql-database";
import { TeamMembershipStore } from "../db/team-memberships";
import type { RequestContext } from "../http/request-context";
import { createTestEnv, emptyStatement, TEST_SESSION_ROW } from "../router.test-support";
import type { Env } from "../types";
import * as resourceViewers from "./resource-viewer";
import { evaluateSessionAdmission, evaluateSessionAdmissions } from "./session-admission";
import type { TeamsEnforcementMode } from "./teams-enforcement";

const modes: TeamsEnforcementMode[] = ["off", "shadow", "on"];
const teamRoles: (TeamRole | null)[] = [null, "member", "lead"];
const roleKeys: (BuiltInRoleKey | null)[] = [...BUILT_IN_ROLE_KEYS, null];
const visibilities: SessionVisibility[] = ["workspace", "team", "private"];
let sessions: Map<string, SessionEntry>;
let collaborators: Map<string, string[]>;
let memberships: Map<string, TeamRole>;

function session(id: string, overrides: Partial<SessionEntry> = {}): SessionEntry {
  return { ...toSessionFields(TEST_SESSION_ROW), id, userId: "another-user", ...overrides };
}

function request(roleKey: BuiltInRoleKey | null = "member") {
  const audits: { sessionId: unknown; teamId: unknown; values: unknown[] }[] = [];
  const prepare = vi.fn((sql: string): SqlStatement => {
    expect(sql).toContain("INSERT INTO authorization_audit_events");
    expect(sql).toContain("'session.private_break_glass'");
    let bindings: unknown[] = [];
    const statement: SqlStatement = {
      ...emptyStatement(),
      bind(...values) {
        bindings = values;
        return statement;
      },
      run: async <T>() => {
        // Ignore the generated event ID and timestamp, retaining all audit evidence.
        audits.push({ sessionId: bindings[6], teamId: bindings[7], values: bindings.slice(2) });
        return { results: [] as T[], meta: { changes: 1 } };
      },
    };
    return statement;
  });
  const db: SqlDatabase = { prepare, batch: async () => [] };
  const ctx: RequestContext = {
    db,
    request_id: "session-admission",
    trace_id: "session-admission",
    metrics: createRequestMetrics(),
    executionCtx: createTestBackgroundTasks(),
    principal: { kind: "user", userId: "user" },
    authorization: {
      userId: "user",
      role: roleKey
        ? { ...BUILT_IN_ROLE_REGISTRY[roleKey], name: roleKey }
        : { id: "custom-role", key: null, name: "Custom" },
      permissions: roleKey ? permissionsForBuiltInRole(roleKey) : [],
      suspendedAt: null,
    },
  };
  return { ctx, audits, prepare };
}

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of items) result.push(item);
  return result;
}

async function expectSingleParity(
  ids: readonly string[],
  env: Env,
  action: SessionAction,
  batch: ReturnType<typeof request>,
  single: ReturnType<typeof request>,
  enforceAlways = false
) {
  const expected = [];
  for (const sessionId of ids) {
    expected.push({
      sessionId,
      row: sessions.get(sessionId) ?? null,
      outcome: await evaluateSessionAdmission(
        single.ctx,
        env,
        sessionId,
        action,
        null,
        enforceAlways
      ),
    });
  }
  const actual = await collect(
    evaluateSessionAdmissions(batch.ctx, env, ids, action, enforceAlways)
  );
  expect(actual).toEqual(expected);
  expect(batch.audits).toEqual(single.audits);
  expect(batch.ctx.shadowBatchDenials).toEqual(single.ctx.shadowBatchDenials);
  expect(batch.ctx.shadowSessionDenial).toEqual(single.ctx.shadowSessionDenial);
  return actual;
}

beforeEach(() => {
  sessions = new Map();
  collaborators = new Map();
  memberships = new Map();
  vi.spyOn(SessionIndexStore.prototype, "get").mockImplementation(
    async (id) => sessions.get(id) ?? null
  );
  vi.spyOn(SessionIndexStore.prototype, "getByIds").mockImplementation(
    async (ids) => new Map([...sessions].filter(([id]) => ids.includes(id)).reverse())
  );
  vi.spyOn(SessionCollaboratorStore.prototype, "listUserIds").mockImplementation(
    async (id) => collaborators.get(id) ?? []
  );
  vi.spyOn(SessionCollaboratorStore.prototype, "listForSessions").mockImplementation(
    async (ids, options = {}) =>
      new Map(
        [...collaborators]
          .filter(
            ([id]) =>
              ids.includes(id) &&
              (!options.privateOnly || sessions.get(id)?.visibility === "private")
          )
          .reverse()
      )
  );
  vi.spyOn(TeamMembershipStore.prototype, "listForUser").mockImplementation(
    async () => memberships
  );
  vi.spyOn(resourceViewers, "resourceViewer");
});
afterEach(() => vi.restoreAllMocks());

describe("evaluateSessionAdmissions policy parity", () => {
  const matrix = modes.flatMap((mode) =>
    roleKeys.flatMap((roleKey) =>
      teamRoles.flatMap((teamRole) =>
        SESSION_ACTIONS.map((action) => ({ mode, roleKey, teamRole, action }))
      )
    )
  );

  it.each(matrix)(
    "$mode $action for role=$roleKey membership=$teamRole across visibility and ownership",
    async ({ mode, roleKey, teamRole, action }) => {
      if (teamRole) memberships.set("team", teamRole);
      for (const visibility of visibilities) {
        for (const ownerTeamId of [null, "team"]) {
          const row = session(`${visibility}-${ownerTeamId ?? "workspace"}`, {
            visibility,
            ownerTeamId,
          });
          sessions.set(row.id, row);
        }
      }
      const ids = [...sessions.keys()];
      ids.splice(2, 0, "missing");
      await expectSingleParity(
        ids,
        createTestEnv({ TEAMS_ENFORCEMENT: mode }),
        action,
        request(roleKey),
        request(roleKey)
      );
    }
  );

  it.each(modes.flatMap((mode) => SESSION_ACTIONS.map((action) => ({ mode, action }))))(
    "$mode $action preserves session ownership and collaborator participation",
    async ({ mode, action }) => {
      memberships.set("team", "member");
      for (const ownerTeamId of [null, "team"]) {
        for (const participation of ["owner", "collaborator", "neither"]) {
          const row = session(`${ownerTeamId ?? "workspace"}-${participation}`, {
            ownerTeamId,
            visibility: "private",
            userId: participation === "owner" ? "user" : null,
          });
          sessions.set(row.id, row);
          if (participation === "collaborator") collaborators.set(row.id, ["another-user", "user"]);
        }
      }
      await expectSingleParity(
        [...sessions.keys()],
        createTestEnv({ TEAMS_ENFORCEMENT: mode }),
        action,
        request(),
        request()
      );
    }
  );

  it.each(["collaborate", "sandbox"] as const)(
    "%s honors collaborators but stale team grants lapse without membership",
    async (action) => {
      sessions.set("workspace-grant", session("workspace-grant", { visibility: "private" }));
      sessions.set(
        "team-grant",
        session("team-grant", { visibility: "private", ownerTeamId: "team" })
      );
      sessions.set("unrelated", session("unrelated", { visibility: "private" }));
      collaborators.set("workspace-grant", ["user"]);
      collaborators.set("team-grant", ["user"]);
      const env = createTestEnv({ TEAMS_ENFORCEMENT: "on" });
      const ids = [...sessions.keys()];
      const actual = await expectSingleParity(ids, env, action, request(), request());
      expect(actual.map(({ outcome }) => outcome)).toEqual([
        { kind: "allowed", legacyPermission: null },
        { kind: "not_found" },
        { kind: "not_found" },
      ]);
      memberships.set("team", "member");
      const restored = await expectSingleParity(ids, env, action, request(), request());
      expect(restored[1].outcome).toEqual({ kind: "allowed", legacyPermission: null });
    }
  );

  it.each(modes)("%s preserves suspended-user admission", async (mode) => {
    sessions.set("public", session("public", { userId: "user" }));
    sessions.set("private", session("private", { visibility: "private", userId: "user" }));
    const batch = request();
    const single = request();
    batch.ctx.authorization!.suspendedAt = 1;
    single.ctx.authorization!.suspendedAt = 1;
    await expectSingleParity(
      ["public", "missing", "private"],
      createTestEnv({ TEAMS_ENFORCEMENT: mode }),
      "lifecycle",
      batch,
      single
    );
    expect(batch.audits).toEqual([]);
  });

  it.each(SESSION_ACTIONS)("enforceAlways bypasses invalid rollout mode for %s", async (action) => {
    sessions.set("owned", session("owned", { userId: "user" }));
    sessions.set("team", session("team", { ownerTeamId: "team" }));
    sessions.set("private", session("private", { visibility: "private" }));
    const batch = request();
    const single = request();
    await expectSingleParity(
      ["owned", "missing", "private", "team"],
      createTestEnv({ TEAMS_ENFORCEMENT: "invalid" }),
      action,
      batch,
      single,
      true
    );
    expect(batch.ctx.teamsEnforcementMode).toBeUndefined();
    expect(single.ctx.teamsEnforcementMode).toBeUndefined();
  });

  it("rejects invalid rollout modes like single-item admission when not forced", async () => {
    const env = createTestEnv({ TEAMS_ENFORCEMENT: "invalid" });
    await expect(
      collect(evaluateSessionAdmissions(request().ctx, env, ["session"], "read"))
    ).rejects.toThrow("Invalid TEAMS_ENFORCEMENT: invalid");
    await expect(
      evaluateSessionAdmission(request().ctx, env, "session", "read", null)
    ).rejects.toThrow("Invalid TEAMS_ENFORCEMENT: invalid");
  });

  it.each(
    modes.flatMap((mode) =>
      [null, "team", "other-team"].flatMap((teamId) =>
        [false, true].flatMap((workspaceOnly) =>
          (["read", "lifecycle"] as const).map((action) => ({
            mode,
            teamId,
            workspaceOnly,
            action,
          }))
        )
      )
    )
  )(
    "$mode $action preserves actorless scope=$teamId workspaceOnly=$workspaceOnly",
    async ({ mode, teamId, workspaceOnly, action }) => {
      for (const visibility of visibilities) {
        for (const ownerTeamId of [null, "team"]) {
          const row = session(`${visibility}-${ownerTeamId ?? "workspace"}`, {
            visibility,
            ownerTeamId,
          });
          sessions.set(row.id, row);
        }
      }
      const batch = request();
      const single = request();
      for (const { ctx } of [batch, single]) {
        ctx.principal = { kind: "service", service: "linear-bot", actor: null };
        delete ctx.authorization;
        ctx.serviceTeamId = teamId;
        ctx.serviceWorkspaceSessionsOnly = workspaceOnly;
      }
      await expectSingleParity(
        [...sessions.keys(), "missing"],
        createTestEnv({ TEAMS_ENFORCEMENT: mode }),
        action,
        batch,
        single
      );
      expect(TeamMembershipStore.prototype.listForUser).not.toHaveBeenCalled();
      expect(batch.audits).toEqual([]);
    }
  );

  it.each(
    modes.flatMap((mode) => [null, "team", "other-team"].map((teamId) => ({ mode, teamId })))
  )("$mode preserves Slack publication gating for binding=$teamId", async ({ mode, teamId }) => {
    sessions.set("workspace", session("workspace"));
    sessions.set("team", session("team", { ownerTeamId: "team" }));
    sessions.set("private", session("private", { ownerTeamId: "team", visibility: "private" }));
    const batch = request();
    const single = request();
    for (const { ctx } of [batch, single]) {
      ctx.principal = { kind: "service", service: "slack-bot", actor: null };
      delete ctx.authorization;
      ctx.serviceTeamId = teamId;
      ctx.serviceReadPurpose = "slack-post";
    }
    const actual = await expectSingleParity(
      ["workspace", "private", "team", "missing"],
      createTestEnv({ TEAMS_ENFORCEMENT: mode }),
      "read",
      batch,
      single
    );
    expect(actual[1].outcome).toEqual({ kind: "not_found" });
    if (teamId) expect(actual[0].outcome).toEqual({ kind: "not_found" });
    expect(TeamMembershipStore.prototype.listForUser).not.toHaveBeenCalled();
  });
});

describe("evaluateSessionAdmissions iteration and reads", () => {
  it.each(modes)(
    "%s stops at a missing first ID without collaborators or memberships",
    async (mode) => {
      sessions.set("later", session("later", { ownerTeamId: "team", visibility: "private" }));
      vi.mocked(SessionCollaboratorStore.prototype.listForSessions).mockRejectedValue(
        new Error("Collaborator lookup must not run")
      );
      vi.mocked(TeamMembershipStore.prototype.listForUser).mockRejectedValue(
        new Error("Membership lookup must not run")
      );
      const batch = request();
      const items = evaluateSessionAdmissions(
        batch.ctx,
        createTestEnv({ TEAMS_ENFORCEMENT: mode }),
        ["missing", "later"],
        "read"
      );

      expect(await items.next()).toEqual({
        value: { sessionId: "missing", row: null, outcome: { kind: "not_found" } },
        done: false,
      });
      await items.return(undefined);

      expect(SessionIndexStore.prototype.getByIds).toHaveBeenCalledExactlyOnceWith([
        "missing",
        "later",
      ]);
      expect(SessionCollaboratorStore.prototype.listForSessions).not.toHaveBeenCalled();
      expect(SessionCollaboratorStore.prototype.listUserIds).not.toHaveBeenCalled();
      expect(TeamMembershipStore.prototype.listForUser).not.toHaveBeenCalled();
      expect(resourceViewers.resourceViewer).not.toHaveBeenCalled();
      expect(batch.ctx.sessionMemberships).toBeUndefined();
      expect(batch.ctx.shadowBatchDenials).toBeUndefined();
      expect(batch.audits).toEqual([]);
    }
  );

  it.each(
    modes.flatMap((mode) =>
      (["private", "channel-mismatch"] as const).map((denial) => ({ mode, denial }))
    )
  )(
    "$mode stops at Slack $denial without collaborators or memberships",
    async ({ mode, denial }) => {
      const blocked = session("blocked", {
        ownerTeamId: denial === "private" ? "team" : "other-team",
        visibility: denial === "private" ? "private" : "workspace",
      });
      sessions.set(blocked.id, blocked);
      sessions.set("later", session("later", { ownerTeamId: "team" }));
      vi.mocked(SessionCollaboratorStore.prototype.listForSessions).mockRejectedValue(
        new Error("Collaborator lookup must not run")
      );
      vi.mocked(TeamMembershipStore.prototype.listForUser).mockRejectedValue(
        new Error("Membership lookup must not run")
      );
      const batch = request("owner");
      batch.ctx.serviceReadPurpose = "slack-post";
      batch.ctx.serviceTeamId = "team";
      const items = evaluateSessionAdmissions(
        batch.ctx,
        createTestEnv({ TEAMS_ENFORCEMENT: mode }),
        ["blocked", "later"],
        "read"
      );

      expect(await items.next()).toEqual({
        value: { sessionId: "blocked", row: blocked, outcome: { kind: "not_found" } },
        done: false,
      });
      await items.return(undefined);

      expect(SessionIndexStore.prototype.getByIds).toHaveBeenCalledExactlyOnceWith([
        "blocked",
        "later",
      ]);
      expect(SessionCollaboratorStore.prototype.listForSessions).not.toHaveBeenCalled();
      expect(SessionCollaboratorStore.prototype.listUserIds).not.toHaveBeenCalled();
      expect(TeamMembershipStore.prototype.listForUser).not.toHaveBeenCalled();
      expect(batch.ctx.sessionMemberships).toBeUndefined();
      expect(batch.ctx.sessionAdmission).toBeUndefined();
      expect(batch.ctx.childSessionAdmission).toBeUndefined();
      expect(batch.ctx.shadowBatchDenials).toBeUndefined();
      expect(batch.audits).toEqual([]);
    }
  );

  it("preserves caller order, missing rows, repeated IDs, and break-glass audit evidence", async () => {
    sessions.set("private-a", session("private-a", { visibility: "private" }));
    sessions.set("private-b", session("private-b", { visibility: "private", ownerTeamId: "team" }));
    memberships.set("team", "member");
    const batch = request("owner");
    const actual = await expectSingleParity(
      ["private-b", "missing", "private-a", "private-b"],
      createTestEnv({ TEAMS_ENFORCEMENT: "shadow" }),
      "collaborate",
      batch,
      request("owner")
    );
    expect(actual.map(({ outcome }) => outcome)).toEqual([
      { kind: "action_denied", reason: "not_collaborator" },
      { kind: "not_found" },
      { kind: "action_denied", reason: "not_collaborator" },
      { kind: "action_denied", reason: "not_collaborator" },
    ]);
    expect(batch.audits.map(({ sessionId, teamId }) => ({ sessionId, teamId }))).toEqual([
      { sessionId: "private-b", teamId: "team" },
      { sessionId: "private-a", teamId: null },
      { sessionId: "private-b", teamId: "team" },
    ]);
  });

  it("appends shadow denials in caller order without replacing existing request evidence", async () => {
    sessions.set("team-a", session("team-a", { visibility: "team", ownerTeamId: "team" }));
    sessions.set("team-b", session("team-b", { visibility: "team", ownerTeamId: "team" }));
    sessions.set("public", session("public"));
    const batch = request();
    const single = request();
    for (const { ctx } of [batch, single]) {
      ctx.shadowBatchDenials = [{ sessionId: "earlier", reason: "missing_permission" }];
      ctx.shadowSessionDenial = "earlier-slot-denial";
    }
    await expectSingleParity(
      ["team-b", "public", "missing", "team-a", "team-b"],
      createTestEnv({ TEAMS_ENFORCEMENT: "shadow" }),
      "read",
      batch,
      single
    );
    expect(batch.ctx.shadowBatchDenials).toEqual([
      { sessionId: "earlier", reason: "missing_permission" },
      { sessionId: "team-b", reason: "not_member" },
      { sessionId: "team-a", reason: "not_member" },
      { sessionId: "team-b", reason: "not_member" },
    ]);
    expect(batch.ctx.shadowSessionDenial).toBe("earlier-slot-denial");
  });

  it.each(["break-glass", "shadow"] as const)(
    "%s effects stop at the last consumed item",
    async (effect) => {
      for (const id of ["first", "later"]) {
        sessions.set(
          id,
          session(
            id,
            effect === "break-glass"
              ? { visibility: "private" }
              : { visibility: "team", ownerTeamId: "team" }
          )
        );
      }
      const batch = request(effect === "break-glass" ? "owner" : "member");
      const items = evaluateSessionAdmissions(
        batch.ctx,
        createTestEnv({ TEAMS_ENFORCEMENT: "shadow" }),
        ["first", "later"],
        "read"
      );
      expect(batch.audits).toEqual([]);
      expect(batch.ctx.shadowBatchDenials).toBeUndefined();
      expect(SessionIndexStore.prototype.getByIds).not.toHaveBeenCalled();
      for await (const item of items) {
        expect(item.sessionId).toBe("first");
        break;
      }
      if (effect === "break-glass") {
        expect(batch.audits.map(({ sessionId }) => sessionId)).toEqual(["first"]);
        expect(batch.ctx.shadowBatchDenials).toBeUndefined();
      } else {
        expect(batch.audits).toEqual([]);
        expect(batch.ctx.shadowBatchDenials).toEqual([
          { sessionId: "first", reason: "not_member" },
        ]);
      }
      expect(await items.next()).toEqual({ value: undefined, done: true });
      expect(SessionIndexStore.prototype.getByIds).toHaveBeenCalledTimes(1);
      expect(SessionCollaboratorStore.prototype.listForSessions).toHaveBeenCalledTimes(1);
    }
  );

  it.each([undefined, "slack-post"] as const)(
    "never overwrites parent or child admission slots (read purpose=%s)",
    async (purpose) => {
      sessions.set("public", session("public"));
      sessions.set("private", session("private", { visibility: "private" }));
      const batch = request("owner");
      const single = request("owner");
      const viewer = { kind: "service", teamId: null } as const;
      const parent = {
        row: { ...session("parent"), ownerUserId: null, collaboratorIds: [] },
        viewer,
      };
      const child = {
        row: { ...session("child"), ownerUserId: null, collaboratorIds: [] },
        viewer,
      };
      for (const { ctx } of [batch, single]) {
        ctx.sessionAdmission = parent;
        ctx.childSessionAdmission = child;
        ctx.serviceReadPurpose = purpose;
      }
      await expectSingleParity(
        ["private", "missing", "public"],
        createTestEnv({ TEAMS_ENFORCEMENT: "on" }),
        "read",
        batch,
        single
      );
      expect(batch.ctx.sessionAdmission).toBe(parent);
      expect(batch.ctx.childSessionAdmission).toBe(child);
    }
  );

  it("uses one bulk call per store and one request viewer for many IDs", async () => {
    const ids = Array.from(
      { length: MAX_D1_QUERY_PARAMETERS * 3 + 7 },
      (_, index) => `session-${index}`
    );
    for (const id of ids) sessions.set(id, session(id, { ownerTeamId: "team" }));
    memberships.set("team", "member");
    const batch = request();
    const actual = await collect(
      evaluateSessionAdmissions(
        batch.ctx,
        createTestEnv({ TEAMS_ENFORCEMENT: "on" }),
        ids,
        "lifecycle"
      )
    );
    expect(actual.map(({ sessionId }) => sessionId)).toEqual(ids);
    expect(
      actual.every(({ outcome }) => outcome.kind === "allowed" && outcome.legacyPermission === null)
    ).toBe(true);
    expect(SessionIndexStore.prototype.getByIds).toHaveBeenCalledExactlyOnceWith(ids);
    expect(SessionCollaboratorStore.prototype.listForSessions).toHaveBeenCalledTimes(1);
    const [collaboratorIds, options] = vi.mocked(SessionCollaboratorStore.prototype.listForSessions)
      .mock.calls[0];
    expect([...collaboratorIds].sort()).toEqual([...ids].sort());
    expect(options?.privateOnly).not.toBe(true);
    expect(SessionIndexStore.prototype.get).not.toHaveBeenCalled();
    expect(SessionCollaboratorStore.prototype.listUserIds).not.toHaveBeenCalled();
    expect(TeamMembershipStore.prototype.listForUser).toHaveBeenCalledExactlyOnceWith("user");
    expect(resourceViewers.resourceViewer).toHaveBeenCalledTimes(1);
    expect(batch.ctx.sessionMemberships).toBe(memberships);
  });

  it.each(SESSION_ACTIONS)(
    "off-mode teamless public %s skips memberships without caching a skip",
    async (action) => {
      sessions.set("first", session("first"));
      sessions.set("last", session("last"));
      vi.mocked(SessionCollaboratorStore.prototype.listForSessions).mockRejectedValue(
        new Error("Legacy admission must not load collaborators")
      );
      vi.mocked(SessionCollaboratorStore.prototype.listUserIds).mockRejectedValue(
        new Error("Legacy admission must not load collaborators")
      );
      const batch = request(null);
      const single = request(null);
      const actual = await expectSingleParity(
        ["first", "missing", "last"],
        createTestEnv({ TEAMS_ENFORCEMENT: "off" }),
        action,
        batch,
        single
      );
      expect(actual[0].outcome.kind).toBe("allowed");
      expect(actual[2].outcome.kind).toBe("allowed");
      expect(SessionCollaboratorStore.prototype.listForSessions).not.toHaveBeenCalled();
      expect(SessionCollaboratorStore.prototype.listUserIds).not.toHaveBeenCalled();
      expect(TeamMembershipStore.prototype.listForUser).not.toHaveBeenCalled();
      expect(batch.ctx.sessionMemberships).toBeUndefined();
      expect(single.ctx.sessionMemberships).toBeUndefined();
    }
  );

  it("loads memberships once for mixed rollback rows, rather than caching the public-row skip", async () => {
    sessions.set("public", session("public"));
    sessions.set(
      "team-private",
      session("team-private", { ownerTeamId: "team", visibility: "private" })
    );
    collaborators.set("team-private", ["user"]);
    memberships.set("team", "member");
    const batch = request();
    const actual = await collect(
      evaluateSessionAdmissions(
        batch.ctx,
        createTestEnv({ TEAMS_ENFORCEMENT: "off" }),
        ["public", "team-private"],
        "collaborate"
      )
    );
    expect(actual.map(({ outcome }) => outcome)).toEqual([
      { kind: "allowed", legacyPermission: "sessions.collaborate" },
      { kind: "allowed", legacyPermission: null },
    ]);
    expect(TeamMembershipStore.prototype.listForUser).toHaveBeenCalledExactlyOnceWith("user");
    expect(batch.ctx.sessionMemberships).toBe(memberships);
  });

  it("reuses a preloaded membership cache", async () => {
    sessions.set("team", session("team", { ownerTeamId: "team", visibility: "team" }));
    const batch = request();
    const cached = new Map<string, TeamRole>([["team", "lead"]]);
    batch.ctx.sessionMemberships = cached;
    const actual = await collect(
      evaluateSessionAdmissions(
        batch.ctx,
        createTestEnv({ TEAMS_ENFORCEMENT: "on" }),
        ["team"],
        "delete"
      )
    );
    expect(actual[0].outcome).toEqual({ kind: "allowed", legacyPermission: null });
    expect(TeamMembershipStore.prototype.listForUser).not.toHaveBeenCalled();
    expect(batch.ctx.sessionMemberships).toBe(cached);
  });

  it("does no reads or viewer resolution for empty input", async () => {
    const batch = request();
    delete batch.ctx.authorization;
    delete batch.ctx.principal;
    expect(
      await collect(evaluateSessionAdmissions(batch.ctx, createTestEnv(), [], "read"))
    ).toEqual([]);
    expect(SessionIndexStore.prototype.getByIds).not.toHaveBeenCalled();
    expect(SessionIndexStore.prototype.get).not.toHaveBeenCalled();
    expect(SessionCollaboratorStore.prototype.listForSessions).not.toHaveBeenCalled();
    expect(SessionCollaboratorStore.prototype.listUserIds).not.toHaveBeenCalled();
    expect(TeamMembershipStore.prototype.listForUser).not.toHaveBeenCalled();
    expect(resourceViewers.resourceViewer).not.toHaveBeenCalled();
    expect(batch.prepare).not.toHaveBeenCalled();
    expect(batch.ctx.sessionMemberships).toBeUndefined();
  });
});
