import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_ACTIONS, type AccessDenialReason } from "@open-inspect/shared";
import {
  BUILT_IN_ROLE_REGISTRY,
  permissionsForBuiltInRole,
  type BuiltInRoleKey,
  type PermissionId,
} from "@open-inspect/shared/rbac";
import type { TeamRole } from "@open-inspect/shared/types/teams";
import { createTestBackgroundTasks } from "../background-tasks.test-support";
import { createRequestMetrics } from "../db/instrumented-sql-database";
import { MAX_D1_QUERY_PARAMETERS } from "../db/query-limits";
import { SessionCollaboratorStore } from "../db/session-collaborators";
import { SessionIndexStore, type SessionEntry } from "../db/session-index";
import { toSessionFields } from "../db/session-row";
import type { SqlStatement } from "../db/sql-database";
import { TeamMembershipStore } from "../db/team-memberships";
import type { RequestContext } from "../http/request-context";
import { createTestEnv, emptyStatement, TEST_SESSION_ROW } from "../router.test-support";
import * as viewers from "./resource-viewer";
import {
  evaluateSessionAdmission as admitOne,
  evaluateSessionAdmissions as admit,
} from "./session-admission";

const index = SessionIndexStore.prototype;
const grants = SessionCollaboratorStore.prototype;
const teams = TeamMembershipStore.prototype;
let sessions: Map<string, SessionEntry>;
let collaborators: Map<string, string[]>;
let memberships: Map<string, TeamRole>;
const env = (mode = "on") => createTestEnv({ TEAMS_ENFORCEMENT: mode });
function seed(id: string, overrides: Partial<SessionEntry> = {}) {
  const row = { ...toSessionFields(TEST_SESSION_ROW), id, userId: "another-user", ...overrides };
  sessions.set(id, row);
}

function request(roleKey: BuiltInRoleKey | null = "member", permissions?: PermissionId[]) {
  const audits: unknown[][] = [];
  const writeAudit = vi.fn<(sessionId: string) => Promise<void>>(async () => undefined);
  const prepare = vi.fn((sql: string): SqlStatement => {
    expect(sql).toContain("'session.private_break_glass'");
    let bindings: unknown[] = [];
    const statement: SqlStatement = {
      ...emptyStatement(),
      bind(...values) {
        bindings = values;
        return statement;
      },
      run: async <T>() => {
        await writeAudit(bindings[6] as string);
        audits.push(bindings.slice(2));
        return { results: [] as T[], meta: { changes: 1 } };
      },
    };
    return statement;
  });
  const ctx: RequestContext = {
    db: { prepare, batch: vi.fn(async () => []) },
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
      permissions: permissions ?? (roleKey ? permissionsForBuiltInRole(roleKey) : []),
      suspendedAt: null,
    },
  };
  return { ctx, audits, writeAudit, prepare };
}

function expectedResult(
  ids: readonly string[],
  outcome: "allowed" | "not_found" | AccessDenialReason
) {
  if (outcome === "allowed") return { kind: "allowed", rows: ids.map((id) => sessions.get(id)!) };
  const denial =
    outcome === "not_found" ? { kind: "not_found" } : { kind: "action_denied", reason: outcome };
  return { kind: "denied", sessionId: ids[0], outcome: denial };
}

beforeEach(() => {
  sessions = new Map();
  collaborators = new Map();
  memberships = new Map();
  vi.spyOn(index, "get").mockImplementation(async (id) => sessions.get(id) ?? null);
  vi.spyOn(index, "getByIds").mockImplementation(
    async (ids) => new Map([...sessions].filter(([id]) => ids.includes(id)).reverse())
  );
  vi.spyOn(grants, "listUserIds").mockImplementation(async (id) => collaborators.get(id) ?? []);
  vi.spyOn(grants, "listForSessions").mockImplementation(
    async (ids) => new Map([...collaborators].filter(([id]) => ids.includes(id)).reverse())
  );
  vi.spyOn(teams, "listForUser").mockImplementation(async () => memberships);
  vi.spyOn(viewers, "resourceViewer");
});
afterEach(() => vi.restoreAllMocks());

describe("evaluateSessionAdmissions policy", () => {
  it.each([
    ["workspace", null, null, "member", "read", "allowed"],
    ["workspace", null, null, "member", "lifecycle", "allowed"],
    ["workspace", null, null, "member", "delete", "not_owner_or_lead"],
    ["workspace", "team", null, "member", "read", "allowed"],
    ["workspace", "team", null, "member", "lifecycle", "not_member"],
    ["team", "team", null, "member", "read", "not_found"],
    ["team", "team", "member", "member", "read", "allowed"],
    ["team", "team", "lead", "member", "delete", "allowed"],
    ["team", "team", "lead", "member", "changeVisibility", "allowed"],
    ["team", "team", "lead", "member", "manageCollaborators", "not_owner_or_lead"],
    ["team", "team", null, "administrator", "read", "allowed"],
    ["team", "team", null, "administrator", "delete", "not_member"],
    ["team", "team", "lead", "viewer", "delete", "missing_permission"],
    ["workspace", null, null, "viewer", "collaborate", "missing_permission"],
    ["workspace", null, null, "viewer", "lifecycle", "missing_permission"],
    ["workspace", null, null, "viewer", "sandbox", "missing_permission"],
    ["private", null, null, "administrator", "read", "not_found"],
    ["private", null, null, "owner", "read", "allowed"],
    ["private", null, null, "owner", "collaborate", "not_collaborator"],
    ["private", null, null, "owner", "sandbox", "not_collaborator"],
    ["private", null, null, "owner", "manageCollaborators", "allowed"],
    ["private", null, null, "owner", "changeVisibility", "allowed"],
  ] as const)(
    "%s team=%s membership=%s role=%s %s -> %s",
    async (visibility, ownerTeamId, teamRole, role, action, outcome) => {
      seed("target", { visibility, ownerTeamId });
      if (teamRole) memberships.set("team", teamRole);
      const actual = await admit(request(role).ctx, env(), ["target"], action);
      expect(actual).toEqual(expectedResult(["target"], outcome));
    }
  );

  it.each([
    ["on", "owner", null, null, "delete", "allowed"],
    ["on", "owner", null, null, "manageCollaborators", "allowed"],
    ["on", "owner", "team", null, "read", "allowed"],
    ["off", "owner", "team", null, "lifecycle", "not_member"],
    ["on", "owner", "team", "member", "changeVisibility", "allowed"],
    ["shadow", "grant", null, null, "collaborate", "allowed"],
    ["on", "grant", null, null, "sandbox", "allowed"],
    ["on", "grant", null, null, "manageCollaborators", "not_owner_or_lead"],
    ["on", "grant", "team", null, "collaborate", "not_found"],
    ["off", "grant", "team", null, "collaborate", "not_found"],
    ["shadow", "grant", "team", null, "read", "not_found"],
    ["on", "grant", "team", "member", "collaborate", "allowed"],
    ["on", "grant", "team", "lead", "delete", "allowed"],
    ["on", "grant", "team", "lead", "changeVisibility", "not_owner_or_lead"],
  ] as const)(
    "%s private %s team=%s membership=%s %s -> %s",
    async (mode, relation, ownerTeamId, teamRole, action, outcome) => {
      const userId = relation === "owner" ? "user" : null;
      seed("target", { visibility: "private", ownerTeamId, userId });
      if (relation === "grant") collaborators.set("target", ["another-user", "user"]);
      if (teamRole) memberships.set("team", teamRole);
      const batch = request();
      const actual = await admit(batch.ctx, env(mode), ["target"], action);
      expect(actual).toEqual(expectedResult(["target"], outcome));
      expect(batch.audits).toEqual([]);
    }
  );

  it.each([
    ["on", "workspace", null, "lifecycle", false, "not_found", null],
    ["shadow", "workspace", null, "lifecycle", false, "allowed", "suspended"],
    ["off", "workspace", null, "lifecycle", false, "allowed", null],
    ["shadow", "private", null, "read", false, "suspended", null],
    ["off", "private", null, "read", false, "suspended", null],
    ["off", "workspace", "team", "lifecycle", false, "suspended", null],
    ["invalid", "workspace", null, "read", true, "not_found", null],
  ] as const)(
    "%s suspended %s team=%s %s forced=%s -> %s",
    async (mode, visibility, ownerTeamId, action, forced, outcome, shadow) => {
      seed("target", { visibility, ownerTeamId });
      const batch = request();
      batch.ctx.authorization!.suspendedAt = 1;
      const actual = await admit(batch.ctx, env(mode), ["target"], action, forced);
      expect(actual).toEqual(expectedResult(["target"], outcome));
      expect(batch.ctx.shadowBatchDenials).toEqual(
        shadow ? [{ sessionId: "target", reason: shadow }] : undefined
      );
      expect(batch.audits).toEqual([]);
      if (forced) expect(batch.ctx.teamsEnforcementMode).toBeUndefined();
    }
  );

  it.each([
    [[], "workspace", null, false, "delete", "not_found"],
    [["sessions.read"], "workspace", null, true, "delete", "missing_permission"],
    [["sessions.read", "sessions.delete"], "workspace", null, true, "delete", "allowed"],
    [["sessions.read", "sessions.delete"], "workspace", null, false, "delete", "not_owner_or_lead"],
    [["sessions.read", "sessions.delete"], "workspace", "team", true, "delete", "not_member"],
    [["sessions.read", "sessions.collaborate"], "private", null, false, "collaborate", "not_found"],
    [["sessions.read", "sessions.collaborate"], "private", null, true, "collaborate", "allowed"],
  ] as const)(
    "custom grants=%j %s team=%s owned=%s %s -> %s",
    async (permissions, visibility, ownerTeamId, owned, action, outcome) => {
      seed("target", { visibility, ownerTeamId, userId: owned ? "user" : null });
      const batch = request(null, [...permissions]);
      const actual = await admit(batch.ctx, env(), ["target"], action);
      expect(actual).toEqual(expectedResult(["target"], outcome));
    }
  );

  it.each(SESSION_ACTIONS)(
    "off legacy %s skips policy; forced admission still enforces it",
    async (action) => {
      seed("target", { userId: "user" });
      const batch = request(null);
      expect(await admit(batch.ctx, env("off"), ["target"], action)).toEqual(
        expectedResult(["target"], "allowed")
      );
      expect(viewers.resourceViewer).not.toHaveBeenCalled();
      expect(batch.ctx.sessionMemberships).toBeUndefined();
      expect(await admit(request(null).ctx, env("invalid"), ["target"], action, true)).toEqual(
        expectedResult(["target"], "not_found")
      );
      expect(grants.listForSessions).not.toHaveBeenCalled();
      expect(grants.listUserIds).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["on", "workspace", "team", "other-team", false, false, "lifecycle", "allowed"],
    ["on", "team", "team", "team", false, false, "delete", "allowed"],
    ["on", "team", "team", null, false, false, "sandbox", "allowed"],
    ["on", "team", "team", "other-team", false, false, "read", "not_found"],
    ["shadow", "team", "team", "other-team", false, false, "read", "allowed"],
    ["on", "workspace", null, null, true, false, "lifecycle", "allowed"],
    ["on", "workspace", "team", null, true, false, "read", "not_found"],
    ["shadow", "workspace", "team", null, true, false, "read", "allowed"],
    ["off", "workspace", "team", null, true, false, "read", "allowed"],
    ["on", "private", null, null, false, false, "read", "not_found"],
    ["off", "private", "team", null, false, false, "read", "not_found"],
    ["off", "private", "team", "team", false, true, "read", "not_found"],
    ["off", "workspace", null, "team", false, true, "read", "not_found"],
    ["shadow", "workspace", "team", "other-team", false, true, "read", "not_found"],
    ["on", "team", "team", "team", false, true, "read", "allowed"],
    ["off", "workspace", null, null, false, true, "read", "allowed"],
  ] as const)(
    "%s service %s owner=%s binding=%s workspaceOnly=%s slack=%s %s -> %s",
    async (mode, visibility, ownerTeamId, teamId, workspaceOnly, slack, action, outcome) => {
      seed("target", { visibility, ownerTeamId });
      const batch = request();
      delete batch.ctx.authorization;
      batch.ctx.principal = {
        kind: "service",
        service: slack ? "slack-bot" : "linear-bot",
        actor: null,
      };
      batch.ctx.serviceTeamId = teamId;
      batch.ctx.serviceWorkspaceSessionsOnly = workspaceOnly;
      batch.ctx.serviceReadPurpose = slack ? "slack-post" : undefined;
      const actual = await admit(batch.ctx, env(mode), ["target"], action);
      expect(actual).toEqual(expectedResult(["target"], outcome));
      expect(teams.listForUser).not.toHaveBeenCalled();
      expect(batch.audits).toEqual([]);
    }
  );
});

describe("ordered preflight and reads", () => {
  it.each([
    ["off", "missing"],
    ["shadow", "missing"],
    ["on", "missing"],
    ["off", "private"],
    ["shadow", "private"],
    ["on", "private"],
    ["off", "channel-mismatch"],
    ["shadow", "channel-mismatch"],
    ["on", "channel-mismatch"],
  ] as const)("%s stops at %s before lazy grants or memberships", async (mode, refusal) => {
    if (refusal !== "missing")
      seed("blocked", {
        visibility: refusal === "private" ? "private" : "workspace",
        ownerTeamId: "other-team",
        userId: "user",
      });
    seed("later", { visibility: "private" });
    vi.mocked(grants.listForSessions).mockRejectedValue(new Error("Unexpected grants read"));
    vi.mocked(teams.listForUser).mockRejectedValue(new Error("Unexpected membership read"));
    const batch = request("owner");
    batch.ctx.serviceReadPurpose = "slack-post";
    batch.ctx.serviceTeamId = "team";
    expect(await admit(batch.ctx, env(mode), ["blocked", "later"], "read")).toEqual(
      expectedResult(["blocked"], "not_found")
    );
    expect(index.getByIds).toHaveBeenCalledExactlyOnceWith(["blocked", "later"]);
    expect(grants.listForSessions).not.toHaveBeenCalled();
    expect(teams.listForUser).not.toHaveBeenCalled();
    expect(batch.ctx.sessionMemberships).toBeUndefined();
    expect(batch.audits).toEqual([]);
  });

  it.each(["workspace", "mixed"] as const)(
    "chunks >100 %s IDs, bulk-loading only private grants",
    async (kind) => {
      const ids = Array.from({ length: MAX_D1_QUERY_PARAMETERS * 2 + 7 }, (_, i) => `session-${i}`);
      for (const [i, id] of ids.entries()) {
        const visibility = kind === "mixed" && i % 3 === 0 ? "private" : "workspace";
        seed(id, { visibility, ownerTeamId: "team", userId: "user" });
      }
      memberships.set("team", "member");
      const batch = request();
      const actual = await admit(batch.ctx, env(), ids, "lifecycle");
      expect(actual).toEqual(expectedResult(ids, "allowed"));
      const chunks = [ids.slice(0, 100), ids.slice(100, 200), ids.slice(200)];
      expect(vi.mocked(index.getByIds).mock.calls.map(([chunk]) => chunk)).toEqual(chunks);
      const privateChunks = chunks.map((chunk) =>
        chunk.filter((id) => sessions.get(id)!.visibility === "private")
      );
      const grantChunks = vi
        .mocked(grants.listForSessions)
        .mock.calls.map(([chunk]) => [...chunk].sort());
      expect(grantChunks).toEqual(
        kind === "workspace" ? [] : privateChunks.map((chunk) => chunk.sort())
      );
      expect(index.get).not.toHaveBeenCalled();
      expect(grants.listUserIds).not.toHaveBeenCalled();
      expect(teams.listForUser).toHaveBeenCalledExactlyOnceWith("user");
      expect(batch.ctx.sessionMemberships).toBe(memberships);
      const cached = new Map<string, TeamRole>([["team", "lead"]]);
      batch.ctx.sessionMemberships = cached;
      const again = await admit(batch.ctx, env("invalid"), ids.slice(0, 2), "delete", true);
      expect(again).toEqual(expectedResult(ids.slice(0, 2), "allowed"));
      expect(teams.listForUser).toHaveBeenCalledTimes(1);
      expect(batch.ctx.sessionMemberships).toBe(cached);
    }
  );

  it.each([
    ["sessions", "missing", "not_found"],
    ["collaborators", "missing", "not_found"],
    ["sessions", "hidden", "not_found"],
    ["collaborators", "hidden", "not_found"],
    ["sessions", "action-denied", "not_member"],
    ["collaborators", "action-denied", "not_member"],
    ["sessions", null, null],
    ["collaborators", null, null],
  ] as const)("later %s chunk failure with first refusal=%s", async (source, refusal, outcome) => {
    const ids = Array.from({ length: MAX_D1_QUERY_PARAMETERS + 1 }, (_, i) => `session-${i}`);
    for (const id of ids) seed(id);
    const last = ids[100];
    seed(last, { visibility: "private", userId: "user" });
    if (refusal === "missing") sessions.delete(ids[0]);
    if (refusal === "hidden") seed(ids[0], { visibility: "private" });
    if (refusal === "action-denied") seed(ids[0], { ownerTeamId: "team" });
    const cause = new Error("Later chunk failed");
    vi.mocked(index.getByIds).mockImplementation(async (chunk) => {
      if (source === "sessions" && chunk.includes(last)) throw cause;
      return new Map([...sessions].filter(([id]) => chunk.includes(id)));
    });
    vi.mocked(grants.listForSessions).mockImplementation(async (chunk) => {
      if (source === "collaborators" && chunk.includes(last)) throw cause;
      return new Map();
    });
    const promise = admit(request().ctx, env(), ids, "lifecycle");
    if (outcome) expect(await promise).toEqual(expectedResult([ids[0]], outcome));
    else await expect(promise).rejects.toBe(cause);
    expect(vi.mocked(index.getByIds).mock.calls.map(([chunk]) => chunk)).toEqual(
      refusal ? [ids.slice(0, 100)] : [ids.slice(0, 100), ids.slice(100)]
    );
    const queriedGrants =
      refusal === "hidden" ? [[ids[0]]] : !refusal && source === "collaborators" ? [[last]] : [];
    expect(vi.mocked(grants.listForSessions).mock.calls.map(([chunk]) => chunk)).toEqual(
      queriedGrants
    );
  });

  it("does not cache the rollback membership skip", async () => {
    seed("public");
    seed("private", { visibility: "private", ownerTeamId: "team" });
    collaborators.set("private", ["user"]);
    memberships.set("team", "member");
    const batch = request();
    const ids = ["public", "private"];
    const actual = await admit(batch.ctx, env("off"), ids, "collaborate");
    expect(actual).toEqual(expectedResult(ids, "allowed"));
    expect(teams.listForUser).toHaveBeenCalledExactlyOnceWith("user");
    expect(batch.ctx.sessionMemberships).toBe(memberships);
  });

  it.each([undefined, "slack-post"] as const)(
    "preserves admission slots (purpose=%s) and single-item full grants",
    async (purpose) => {
      seed("public");
      collaborators.set("public", ["user", "another-user"]);
      const batch = request();
      await admitOne(batch.ctx, env(), "public", "read", "session");
      await admitOne(batch.ctx, env(), "public", "read", "child");
      const parent = batch.ctx.sessionAdmission;
      const child = batch.ctx.childSessionAdmission;
      expect(parent?.row.collaboratorIds).toEqual(["user", "another-user"]);
      expect(child?.row.collaboratorIds).toEqual(["user", "another-user"]);
      batch.ctx.serviceReadPurpose = purpose;
      if (purpose) seed("public", { visibility: "private" });
      const actual = await admit(batch.ctx, env(), ["public", "missing"], "read");
      expect(actual).toEqual(expectedResult([purpose ? "public" : "missing"], "not_found"));
      expect(batch.ctx.sessionAdmission).toBe(parent);
      expect(batch.ctx.childSessionAdmission).toBe(child);
      expect(grants.listUserIds).toHaveBeenCalledTimes(2);
      expect(grants.listForSessions).not.toHaveBeenCalled();
    }
  );

  it("rejects invalid mode before reads, but empty input skips mode/viewer resolution", async () => {
    const batch = request();
    delete batch.ctx.authorization;
    delete batch.ctx.principal;
    expect(await admit(batch.ctx, env("invalid"), [], "read")).toEqual({
      kind: "allowed",
      rows: [],
    });
    await expect(admit(request().ctx, env("invalid"), ["target"], "read")).rejects.toThrow(
      "Invalid TEAMS_ENFORCEMENT: invalid"
    );
    for (const lookup of [
      index.get,
      index.getByIds,
      grants.listUserIds,
      grants.listForSessions,
      teams.listForUser,
      viewers.resourceViewer,
      batch.prepare,
    ])
      expect(lookup).not.toHaveBeenCalled();
    expect(batch.ctx.sessionMemberships).toBeUndefined();
  });
});

describe("audit and shadow prefixes", () => {
  it.each([false, true])(
    "retains caller order/repeats and break-glass evidence (denied=%s)",
    async (denied) => {
      seed("a", { visibility: "private" });
      seed("b", { visibility: "private", ownerTeamId: "team" });
      seed("later", { visibility: "private" });
      const batch = request("owner");
      const ids = denied ? ["b", "a", "b", "missing", "later"] : ["b", "a", "b"];
      const actual = await admit(batch.ctx, env("shadow"), ids, "read");
      expect(actual).toEqual(
        expectedResult(denied ? ["missing"] : ids, denied ? "not_found" : "allowed")
      );
      expect(batch.audits).toEqual(
        ["b", "a", "b"].map((id) => [
          "session-admission",
          "user",
          "user",
          null,
          id,
          id === "b" ? "team" : null,
          "session.private_break_glass",
          JSON.stringify({ before: {}, requested: {}, after: {} }),
        ])
      );
      expect(batch.ctx.db.batch).not.toHaveBeenCalled();
      const single = request("owner");
      const rows: SessionEntry[] = [];
      let expected: Awaited<ReturnType<typeof admit>> = { kind: "allowed", rows };
      for (const id of ids) {
        const outcome = await admitOne(single.ctx, env("shadow"), id, "read", null);
        if (outcome.kind !== "allowed") {
          expected = { kind: "denied", sessionId: id, outcome };
          break;
        }
        rows.push(sessions.get(id)!);
      }
      expect(actual).toEqual(expected);
      expect(batch.audits).toEqual(single.audits);
    }
  );

  it("appends ordered shadow evidence only before denial, preserving existing slots", async () => {
    for (const id of ["a", "b", "later"]) seed(id, { visibility: "team", ownerTeamId: "team" });
    seed("public");
    const batch = request();
    batch.ctx.shadowBatchDenials = [{ sessionId: "earlier", reason: "missing_permission" }];
    batch.ctx.shadowSessionDenial = "earlier-slot-denial";
    const ids = ["b", "public", "a", "b", "missing", "later"];
    const actual = await admit(batch.ctx, env("shadow"), ids, "read");
    expect(actual).toEqual(expectedResult(["missing"], "not_found"));
    expect(batch.ctx.shadowBatchDenials).toEqual([
      { sessionId: "earlier", reason: "missing_permission" },
      { sessionId: "b", reason: "not_member" },
      { sessionId: "a", reason: "not_member" },
      { sessionId: "b", reason: "not_member" },
    ]);
    expect(batch.ctx.shadowSessionDenial).toBe("earlier-slot-denial");
  });

  it.each([false, true])(
    "awaits break-glass before action refusal, stopping later effects (auditFails=%s)",
    async (auditFails) => {
      seed("first", { visibility: "private" });
      seed("fail", { visibility: "private", ownerTeamId: "team" });
      seed("later", { visibility: "private" });
      const batch = request("owner");
      const cause = new Error("Audit failed");
      if (auditFails)
        batch.writeAudit.mockImplementation(async (id) => {
          if (id === "fail") throw cause;
        });
      const promise = admit(batch.ctx, env("shadow"), ["first", "fail", "later"], "lifecycle");
      if (auditFails) await expect(promise).rejects.toBe(cause);
      else expect(await promise).toEqual(expectedResult(["fail"], "not_member"));
      expect(batch.audits.map((values) => values[4])).toEqual(
        auditFails ? ["first"] : ["first", "fail"]
      );
      expect(batch.writeAudit.mock.calls).toEqual([["first"], ["fail"]]);
      expect(batch.ctx.shadowBatchDenials).toBeUndefined();
      expect(batch.ctx.db.batch).not.toHaveBeenCalled();
    }
  );
});
