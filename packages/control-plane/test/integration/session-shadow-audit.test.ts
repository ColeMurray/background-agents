import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type SessionInboxPage,
  type SessionInboxSnapshot,
  sessionInboxPageSchema,
} from "@open-inspect/shared/types/session-inbox";
import {
  type ChildSessionListResponse,
  type SessionListResponse,
  childSessionListResponseSchema,
  sessionListResponseSchema,
} from "@open-inspect/shared/types/sessions";
import {
  TRACE_EXPORT_SCHEMA_VERSION,
  type TraceExportLine,
} from "@open-inspect/shared/types/trace-export";
import type { TeamsEnforcementMode } from "../../src/authorization/teams-enforcement";
import { SessionIndexStore, type SessionEntry } from "../../src/db/session-index";
import { SessionExportStore } from "../../src/db/session-export-store";
import { SessionCollaboratorStore } from "../../src/db/session-collaborators";
import { TeamMembershipStore } from "../../src/db/team-memberships";
import { TeamStore } from "../../src/db/teams";
import { cleanD1Tables } from "./cleanup";
import { routeRequest, seedActiveUser, serviceRequestHeaders } from "./helpers";

const BASE = "https://test.local";
const MEMBER = "22222222222222222222222222222222";
const CREATOR = "33333333333333333333333333333333";
const ADMIN = "44444444444444444444444444444444";
const MEMBER_ACTOR = { userId: MEMBER, role: "member" } as const;
const ADMIN_ACTOR = { userId: ADMIN, role: "administrator" } as const;

async function fetchMode(
  path: string,
  mode: TeamsEnforcementMode,
  as: { userId: string; role: "member" | "administrator" } = MEMBER_ACTOR
) {
  const url = `${BASE}${path}`;
  return routeRequest(
    new Request(url, { headers: await serviceRequestHeaders(url, { as }) }),
    { ...env, TEAMS_ENFORCEMENT: mode },
    createExecutionContext()
  );
}

async function session(id: string, overrides: Partial<SessionEntry> = {}) {
  await new SessionIndexStore(env.DB).create({
    id,
    title: id,
    ownerTeamId: null,
    visibility: "workspace",
    userId: CREATOR,
    repoOwner: "acme",
    repoName: "web-app",
    baseBranch: "main",
    model: "anthropic/claude-haiku-4-5",
    reasoningEffort: null,
    status: "completed",
    spawnSource: overrides.parentSessionId ? "agent" : "user",
    spawnDepth: overrides.parentSessionId ? 1 : 0,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  });
}

async function auditRows(response: Response) {
  const requestId = response.headers.get("x-request-id");
  expect(requestId).toBeTruthy();
  const rows = await env.DB.prepare(
    `SELECT action, reason_code, resource_type, resource_id, actor_user_id_snapshot, metadata_json
     FROM authorization_audit_events WHERE request_id = ?`
  )
    .bind(requestId)
    .all<{
      action: string;
      reason_code: string;
      resource_type: string;
      resource_id: string;
      actor_user_id_snapshot: string;
      metadata_json: string;
    }>();
  return rows.results.map(({ metadata_json, ...row }) => ({
    ...row,
    metadata: JSON.parse(metadata_json) as Record<string, unknown>,
  }));
}

async function expectNoShadowAudit(response: Response) {
  const requestId = response.headers.get("x-request-id");
  expect(requestId).toBeTruthy();
  const rows = await env.DB.prepare(
    `SELECT reason_code FROM authorization_audit_events
     WHERE request_id = ? AND reason_code LIKE 'shadow_denied:%'`
  )
    .bind(requestId)
    .all();
  expect(rows.results).toEqual([]);
}

async function expectShadowAudit(
  response: Response,
  shadowDenialCount: number,
  shadowReason?: string
) {
  const rows = await auditRows(response);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    action: "authorization.request_allowed",
    reason_code: "shadow_denied:batch",
    resource_type: "http_route",
    actor_user_id_snapshot: MEMBER,
    metadata: {
      httpMethod: "GET",
      httpPath: rows[0].resource_id,
      httpStatus: 200,
      responseCode: "shadow_denied:batch",
      requestId: response.headers.get("x-request-id"),
      shadowDenialCount,
      shadowDenialReason: "not_member",
    },
  });
  expect(rows[0].metadata).not.toHaveProperty("shadowDenials");
  expect(
    Object.keys(rows[0].metadata)
      .filter((key) => key.startsWith("shadow"))
      .sort()
  ).toEqual(
    shadowReason === undefined
      ? ["shadowDenialCount", "shadowDenialReason"]
      : ["shadowDenialCount", "shadowDenialReason", "shadowReason"]
  );
  if (shadowReason === undefined) expect(rows[0].metadata).not.toHaveProperty("shadowReason");
  else expect(rows[0].metadata.shadowReason).toBe(shadowReason);
  return rows[0].metadata;
}

async function exportLines(response: Response): Promise<TraceExportLine[]> {
  return new TextDecoder()
    .decode(await response.arrayBuffer())
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as TraceExportLine);
}

describe("COL-270 HTTP session-list shadow audits", () => {
  let teamId: string;

  beforeEach(async () => {
    await cleanD1Tables();
    for (const as of [MEMBER_ACTOR, ADMIN_ACTOR]) {
      await serviceRequestHeaders(`${BASE}/me/authorization`, { as });
    }
    await seedActiveUser(CREATOR);
    const teams = new TeamStore(env.DB);
    const target = await teams.create({
      slug: "shadow-target",
      name: "Shadow target",
      joinPolicy: "invite_only",
    });
    const viewerTeam = await teams.create({
      slug: "shadow-viewer",
      name: "Shadow viewer",
      joinPolicy: "invite_only",
    });
    teamId = target.id;
    const memberships = new TeamMembershipStore(env.DB);
    await memberships.add(teamId, CREATOR);
    await memberships.add(viewerTeam.id, MEMBER);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanD1Tables();
  });

  it("preserves a cross-team GET /sessions response and records one batched shadow observation", async () => {
    await session("workspace", { updatedAt: 100 });
    await session("team", { ownerTeamId: teamId, visibility: "team", updatedAt: 200 });
    await session("private", { visibility: "private", updatedAt: 300 });

    const off = await fetchMode("/sessions", "off");
    expect(off.status).toBe(200);
    const baseline = await off.json<SessionListResponse>();
    expect(baseline.sessions.map(({ id }) => id)).toEqual(["team", "workspace"]);
    await expectNoShadowAudit(off);

    const shadow = await fetchMode("/sessions", "shadow");
    expect(shadow.status).toBe(200);
    expect(await shadow.json()).toEqual(baseline);
    await expectShadowAudit(shadow, 1);

    const on = await fetchMode("/sessions", "on");
    expect(on.status).toBe(200);
    expect(await on.json()).toMatchObject({ sessions: [{ id: "workspace" }], hasMore: false });
    await expectNoShadowAudit(on);
  });

  it.each(["/sessions", "/sessions/inbox", "/sessions/inbox?category=finished"])(
    "does not audit a returned page when collaborator decoration fails for %s",
    async (path) => {
      await session("team", { ownerTeamId: teamId, visibility: "team" });
      vi.spyOn(SessionCollaboratorStore.prototype, "listForSessions").mockRejectedValue(
        new Error("Collaborator lookup failed")
      );

      const response = await fetchMode(path, "shadow");
      expect(response.status).toBe(500);
      await expectNoShadowAudit(response);
    }
  );

  it("does not retain evidence from a successful inbox category when another category fails", async () => {
    await session("team", { ownerTeamId: teamId, visibility: "team" });
    await session("workspace-broken", { status: "active" });
    const decorate = vi
      .spyOn(SessionCollaboratorStore.prototype, "listForSessions")
      .mockImplementation(async (ids) => {
        if (ids.includes("workspace-broken")) throw new Error("Category decoration failed");
        return new Map();
      });

    const response = await fetchMode("/sessions/inbox", "shadow");
    expect(response.status).toBe(500);
    expect(decorate).toHaveBeenCalledWith(["team"], { privateOnly: true });
    await expectNoShadowAudit(response);
  });

  it.each([
    { path: "/sessions", schema: sessionListResponseSchema },
    { path: "/sessions/inbox", schema: sessionInboxPageSchema },
    { path: "/sessions/inbox?category=finished", schema: sessionInboxPageSchema },
    { path: "/sessions/workspace-parent/children", schema: childSessionListResponseSchema },
  ])(
    "does not audit a returned page when response parsing fails for $path",
    async ({ path, schema }) => {
      await session("workspace-parent");
      await session("team-child", {
        parentSessionId: "workspace-parent",
        ownerTeamId: teamId,
        visibility: "team",
      });
      vi.spyOn(schema, "parse").mockImplementation(() => {
        throw new Error("Response parsing failed");
      });

      const response = await fetchMode(path, "shadow");
      expect(response.status).toBe(500);
      await expectNoShadowAudit(response);
    }
  );

  it("audits only the returned offset page, not earlier rows or the lookahead session", async () => {
    await session("workspace", { updatedAt: 400 });
    for (const [id, updatedAt] of [
      ["team-page", 300],
      ["team-lookahead", 200],
      ["team-older", 100],
    ] as const) {
      await session(id, { ownerTeamId: teamId, visibility: "team", updatedAt });
    }

    for (const [offset, id] of ["workspace", "team-page", "team-lookahead"].entries()) {
      const response = await fetchMode(`/sessions?limit=1&offset=${offset}`, "shadow");
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ sessions: [{ id }], hasMore: true });
      if (offset === 0) await expectNoShadowAudit(response);
      else await expectShadowAudit(response, 1);
    }
  });

  it.each(["member", "administrator"] as const)(
    "does not create list shadow audits for an admitted %s",
    async (role) => {
      await session("workspace-parent");
      await session("team-child", {
        parentSessionId: "workspace-parent",
        ownerTeamId: teamId,
        visibility: "team",
      });
      if (role === "member") await new TeamMembershipStore(env.DB).add(teamId, MEMBER);
      const as = role === "member" ? MEMBER_ACTOR : ADMIN_ACTOR;

      for (const path of [
        "/sessions",
        "/sessions/inbox",
        "/sessions/inbox?category=finished",
        "/sessions/workspace-parent/children",
      ]) {
        const response = await fetchMode(path, "shadow", as);
        expect(response.status).toBe(200);
        expect(JSON.stringify(await response.json())).toContain('"id":"team-child"');
        expect(await auditRows(response)).toEqual([]);
      }
    }
  );

  it("audits descendants in both inbox snapshots and category pages without changing their bodies", async () => {
    await session("workspace-root", { updatedAt: 1000 });
    await session("team-child", {
      parentSessionId: "workspace-root",
      ownerTeamId: teamId,
      visibility: "team",
      updatedAt: 3000,
    });
    await session("team-grandchild", {
      parentSessionId: "team-child",
      spawnDepth: 2,
      ownerTeamId: teamId,
      visibility: "team",
      updatedAt: 2000,
    });

    for (const path of ["/sessions/inbox", "/sessions/inbox?category=finished"]) {
      const off = await fetchMode(path, "off");
      expect(off.status).toBe(200);
      const baseline = await off.json();
      await expectNoShadowAudit(off);

      const shadow = await fetchMode(path, "shadow");
      expect(shadow.status).toBe(200);
      expect(await shadow.json()).toEqual(baseline);
      await expectShadowAudit(shadow, 2);

      const on = await fetchMode(path, "on");
      expect(on.status).toBe(200);
      const body = await on.json<SessionInboxSnapshot | SessionInboxPage>();
      const page = "categories" in body ? body.categories.finished : body;
      expect(page.items).toMatchObject([
        { rootSession: { id: "workspace-root" }, descendantSessions: [] },
      ]);
      await expectNoShadowAudit(on);
    }
  });

  it("records one count-only audit across all inbox categories on the same request", async () => {
    await session("team-attention", { ownerTeamId: teamId, visibility: "team" });
    await session("team-progress", { ownerTeamId: teamId, visibility: "team", status: "active" });
    await session("team-finished", { ownerTeamId: teamId, visibility: "team" });
    await new SessionIndexStore(env.DB).recordLatestTerminalMessage({
      sessionId: "team-attention",
      messageId: "attention-message",
      messageCreatedAt: Date.now(),
      terminalMessageCompletedAt: Date.now(),
    });

    const response = await fetchMode("/sessions/inbox", "shadow");
    expect(response.status).toBe(200);
    const body = await response.json<SessionInboxSnapshot>();
    expect(body.categories.needs_attention.items.map(({ rootSession }) => rootSession.id)).toEqual([
      "team-attention",
    ]);
    expect(body.categories.in_progress.items.map(({ rootSession }) => rootSession.id)).toEqual([
      "team-progress",
    ]);
    expect(body.categories.finished.items.map(({ rootSession }) => rootSession.id)).toEqual([
      "team-finished",
    ]);
    const metadata = JSON.stringify(await expectShadowAudit(response, 3));
    for (const id of ["team-attention", "team-progress", "team-finished", teamId]) {
      expect(metadata).not.toContain(id);
    }
  });

  it("counts all 55 inbox descendants without IDs and excludes the lookahead lineage", async () => {
    await session("workspace-root", { updatedAt: 10000 });
    const children = Array.from({ length: 55 }, (_, index) => `team-child-${index}`);
    for (const [index, id] of children.entries()) {
      await session(id, {
        parentSessionId: "workspace-root",
        ownerTeamId: teamId,
        visibility: "team",
        createdAt: 2000 + index,
        updatedAt: 9000 - index,
      });
    }
    for (let index = 0; index < 19; index++) {
      await session(`workspace-${index}`, { updatedAt: 8000 - index });
    }
    await session("lookahead-root", {
      ownerTeamId: teamId,
      visibility: "team",
      updatedAt: 1000,
    });
    await session("lookahead-child", {
      parentSessionId: "lookahead-root",
      ownerTeamId: teamId,
      visibility: "team",
      updatedAt: 900,
    });

    for (const path of ["/sessions/inbox", "/sessions/inbox?category=finished"]) {
      const response = await fetchMode(path, "shadow");
      expect(response.status).toBe(200);
      const body = await response.json<SessionInboxSnapshot | SessionInboxPage>();
      const page = "categories" in body ? body.categories.finished : body;
      expect(page.items).toHaveLength(20);
      expect(page.hasMore).toBe(true);
      expect(page.items[0].rootSession.id).toBe("workspace-root");
      expect(page.items[0].descendantSessions.map(({ id }) => id)).toEqual(children);
      expect(JSON.stringify(page)).not.toContain('"id":"lookahead-root"');
      expect(JSON.stringify(page)).not.toContain('"id":"lookahead-child"');
      const metadata = JSON.stringify(await expectShadowAudit(response, children.length));
      for (const id of [...children, "lookahead-root", "lookahead-child", teamId]) {
        expect(metadata).not.toContain(id);
      }

      const next = await fetchMode(
        `/sessions/inbox?${new URLSearchParams({ category: "finished", cursor: page.nextCursor! })}`,
        "shadow"
      );
      expect(next.status).toBe(200);
      expect(await next.json()).toMatchObject({
        items: [
          {
            rootSession: { id: "lookahead-root" },
            descendantSessions: [{ id: "lookahead-child" }],
          },
        ],
        hasMore: false,
        nextCursor: null,
      });
      const nextMetadata = JSON.stringify(await expectShadowAudit(next, 2));
      for (const id of ["lookahead-root", "lookahead-child", teamId]) {
        expect(nextMetadata).not.toContain(id);
      }
    }
  });

  it("audits a cross-team child of a readable workspace parent only in shadow mode", async () => {
    await session("workspace-parent");
    await session("workspace-child", { parentSessionId: "workspace-parent", createdAt: 2000 });
    await session("team-child", {
      parentSessionId: "workspace-parent",
      ownerTeamId: teamId,
      visibility: "team",
      createdAt: 3000,
    });
    await session("team-grandchild", {
      parentSessionId: "team-child",
      spawnDepth: 2,
      ownerTeamId: teamId,
      visibility: "team",
      createdAt: 4000,
    });

    for (const mode of ["off", "shadow", "on"] as const) {
      const response = await fetchMode("/sessions/workspace-parent/children", mode);
      expect(response.status).toBe(200);
      const body = await response.json<ChildSessionListResponse>();
      expect(body.children.map(({ id }) => id)).toEqual(
        mode === "on" ? ["workspace-child"] : ["team-child", "workspace-child"]
      );
      if (mode === "shadow") await expectShadowAudit(response, 1);
      else await expectNoShadowAudit(response);
    }
  });

  it("retains an admitted parent's shadow reason alongside its children's batch denial", async () => {
    await session("team-parent", { ownerTeamId: teamId, visibility: "team" });
    await session("team-child", {
      parentSessionId: "team-parent",
      ownerTeamId: teamId,
      visibility: "team",
    });

    const response = await fetchMode("/sessions/team-parent/children", "shadow");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ children: [{ id: "team-child" }] });
    const metadata = JSON.stringify(await expectShadowAudit(response, 1, "not_member"));
    for (const id of ["team-child", teamId]) {
      expect(metadata).not.toContain(id);
    }
  });

  describe("streamed exports", () => {
    beforeEach(async () => {
      // A custom reader can export without the workspace-admin team-visibility bypass.
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO roles (id, key, name, normalized_name, is_system)
           VALUES ('role_shadow_export', NULL, 'Shadow Export', 'shadow export', 0)`
        ),
        env.DB.prepare(
          `INSERT INTO role_permissions (role_id, permission_id)
           VALUES ('role_shadow_export', 'sessions.read'), ('role_shadow_export', 'sessions.export')`
        ),
        env.DB.prepare(
          "UPDATE user_role_assignments SET role_id = 'role_shadow_export' WHERE user_id = ?"
        ).bind(MEMBER),
      ]);
    });

    it.each(["off", "shadow", "on"] as const)(
      "preserves the terminal NDJSON selection error in %s mode without retrying the query",
      async (mode) => {
        const select = vi
          .spyOn(SessionExportStore.prototype, "list")
          .mockRejectedValue(new Error("selection unavailable"));
        const response = await fetchMode("/sessions/export", mode);
        expect(response.status).toBe(200);
        await expectNoShadowAudit(response);
        expect(await exportLines(response)).toEqual([
          { schemaVersion: TRACE_EXPORT_SCHEMA_VERSION, type: "error" },
        ]);
        expect(select).toHaveBeenCalledTimes(1);
      }
    );

    it.each(["sessions", "runs"] as const)(
      "preserves %s export rows in shadow and writes its audit before the body is consumed",
      async (scope) => {
        await session("workspace", { createdAt: 100 });
        await session("team", { ownerTeamId: teamId, visibility: "team", createdAt: 200 });
        let baseline: TraceExportLine[] = [];

        for (const mode of ["off", "shadow", "on"] as const) {
          const response = await fetchMode(`/sessions/export?scope=${scope}`, mode);
          expect(response.status).toBe(200);
          expect(response.headers.get("content-type")).toBe("application/x-ndjson");
          expect(response.bodyUsed).toBe(false);
          if (mode === "shadow") await expectShadowAudit(response, 1);
          else {
            await expectNoShadowAudit(response);
            expect(await auditRows(response)).toMatchObject([
              { action: "authorization.request_allowed", reason_code: "authorization_allowed" },
            ]);
          }
          expect(response.bodyUsed).toBe(false);

          const lines = await exportLines(response);
          expect(lines.filter((line) => line.type === "session").map(({ id }) => id)).toEqual(
            mode === "on" ? ["workspace"] : ["team", "workspace"]
          );
          if (mode === "off") baseline = lines;
          if (mode === "shadow") expect(lines).toEqual(baseline);
        }
      }
    );

    it.each(["member", "administrator"] as const)(
      "keeps normal export admission audits without shadow observations for an admitted %s",
      async (role) => {
        await session("team", { ownerTeamId: teamId, visibility: "team" });
        if (role === "member") await new TeamMembershipStore(env.DB).add(teamId, MEMBER);
        const as = role === "member" ? MEMBER_ACTOR : ADMIN_ACTOR;

        for (const scope of ["sessions", "runs"] as const) {
          const response = await fetchMode(`/sessions/export?scope=${scope}`, "shadow", as);
          expect(response.status).toBe(200);
          await expectNoShadowAudit(response);
          expect(await auditRows(response)).toMatchObject([
            { action: "authorization.request_allowed", reason_code: "authorization_allowed" },
          ]);
          expect(response.bodyUsed).toBe(false);
          expect(await exportLines(response)).toMatchObject([{ type: "session", id: "team" }]);
        }
      }
    );

    it.each(["sessions", "runs"] as const)(
      "records the exact %s export page count without IDs before streaming",
      async (scope) => {
        const ids = Array.from({ length: 57 }, (_, index) => `team-${index}`);
        for (const [index, id] of ids.entries()) {
          await session(id, {
            ownerTeamId: teamId,
            visibility: "team",
            createdAt: 10000 - index,
          });
        }

        const response = await fetchMode(`/sessions/export?scope=${scope}&limit=55`, "shadow");
        expect(response.status).toBe(200);
        const metadata = JSON.stringify(await expectShadowAudit(response, 55));
        for (const id of [...ids, teamId]) {
          expect(metadata).not.toContain(id);
        }
        expect(response.bodyUsed).toBe(false);
        const lines = await exportLines(response);
        expect(lines.filter((line) => line.type === "session").map(({ id }) => id)).toEqual(
          ids.slice(0, 55)
        );
        const cursor = lines.find((line) => line.type === "cursor");
        expect(cursor?.nextCursor).toBeTruthy();

        const next = await fetchMode(
          `/sessions/export?${new URLSearchParams({ scope, limit: "55", cursor: cursor!.nextCursor })}`,
          "shadow"
        );
        expect(next.status).toBe(200);
        const nextMetadata = JSON.stringify(await expectShadowAudit(next, ids.length - 55));
        for (const id of [...ids, teamId]) {
          expect(nextMetadata).not.toContain(id);
        }
        expect(next.bodyUsed).toBe(false);
        const nextLines = await exportLines(next);
        expect(nextLines.filter((line) => line.type === "session").map(({ id }) => id)).toEqual(
          ids.slice(55)
        );
        expect(nextLines.some((line) => line.type === "cursor")).toBe(false);
      }
    );

    it("counts a workspace-visible child when runs export would hide it through the root gate", async () => {
      await session("team-root", {
        ownerTeamId: teamId,
        visibility: "team",
        createdAt: 3000,
      });
      await session("workspace-child", {
        parentSessionId: "team-root",
        ownerTeamId: teamId,
        visibility: "workspace",
        createdAt: 4000,
      });
      await session("workspace-root", { createdAt: 1000 });

      const sessions = await fetchMode("/sessions/export?scope=sessions", "on");
      expect(sessions.status).toBe(200);
      await expectNoShadowAudit(sessions);
      expect(
        (await exportLines(sessions)).filter((line) => line.type === "session").map(({ id }) => id)
      ).toEqual(["workspace-child", "workspace-root"]);

      let baseline: TraceExportLine[] = [];
      for (const mode of ["off", "shadow", "on"] as const) {
        const response = await fetchMode("/sessions/export?scope=runs", mode);
        expect(response.status).toBe(200);
        if (mode === "shadow") await expectShadowAudit(response, 2);
        else await expectNoShadowAudit(response);
        expect(response.bodyUsed).toBe(false);
        const lines = await exportLines(response);
        expect(lines.filter((line) => line.type === "session").map(({ id }) => id)).toEqual(
          mode === "on" ? ["workspace-root"] : ["team-root", "workspace-child", "workspace-root"]
        );
        if (mode === "off") baseline = lines;
        if (mode === "shadow") expect(lines).toEqual(baseline);
      }
    });
  });
});
