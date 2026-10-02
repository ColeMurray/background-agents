import {
  projectSourceInputSchema,
  projectPinInputSchema,
} from "@open-inspect/shared/types/projects";
import { SessionInboxStore } from "../../src/db/session-inbox-store";
import { resolvePromptReferences } from "../../src/session/session-references";
import { createCloudflareEnv } from "../../src/cloudflare/platform";
import { Scheduler } from "../../src/scheduler/scheduler";
import { SessionIndexStore } from "../../src/db/session-index";
import { SessionProjectStore } from "../../src/db/session-project-store";
import { buildInjectionBlock } from "@open-inspect/shared/project-context";
import { GitHubSourceControlProvider } from "../../src/source-control/providers/github-provider";
import { SELF, env, createExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanD1Tables } from "./cleanup";
import { AnalyticsStore } from "../../src/db/analytics-store";
import {
  projectViewer,
  loadProjectContext,
  loadProjectSnapshotContext,
} from "../../src/session/project-context";
import { projectSubscriptionReceipt } from "../../src/db/project-subscription";
import {
  serviceFetch,
  routeRequest,
  serviceRequestHeaders,
  sqlDatabase,
  initSession,
  seedSandboxAuth,
  seedMessage,
  seedEvents,
  queryDO,
} from "./helpers";
import { ProjectStore } from "../../src/db/project-store";
const A = "11111111111111111111111111111111";
const B = "22222222222222222222222222222222";
const req = (
  path: string,
  method = "GET",
  body?: object,
  userId = A,
  role: "member" | "viewer" | "administrator" = "member"
) =>
  serviceFetch(`https://test.local${path}`, {
    method,
    as: { userId, role },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
async function create(input: object = {}) {
  const response = await req("/projects", "POST", { name: "Billing", slug: "billing", ...input });
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json<{ project: { id: string } }>()).project;
}
beforeEach(cleanD1Tables);
describe("Projects v1 foundation", () => {
  it("creates, reads, edits, ships and restores with operation audits", async () => {
    const project = await create();
    expect((await req(`/projects/${project.id}`, "PATCH", { brief: "Curated brief" })).status).toBe(
      200
    );
    expect((await req(`/projects/${project.id}/ship`, "POST")).status).toBe(200);
    const detail = await (
      await req(`/projects/${project.id}`)
    ).json<{ project: { status: string; shippedAt: number } }>();
    expect(detail.project.status).toBe("shipped");
    expect(detail.project.shippedAt).toBeGreaterThan(0);
    expect((await req(`/projects/${project.id}/restore`, "POST")).status).toBe(200);
    expect(
      (
        await env.DB.prepare(
          "SELECT action FROM authorization_audit_events WHERE resource_type = 'project'"
        ).all()
      ).results
    ).toHaveLength(4);
  });
  it("keeps read and manage capabilities consistent for an unrelated member and viewer", async () => {
    const project = await create();
    const detail = await (
      await req(`/projects/${project.id}`, "GET", undefined, B)
    ).json<{ project: { capabilities: { canRead: boolean; canEditMetadata: boolean } } }>();
    expect(detail.project.capabilities).toMatchObject({ canRead: true, canEditMetadata: false });
    expect((await req(`/projects/${project.id}`, "PATCH", { name: "No" }, B)).status).toBe(403);
  });
  it("hides team projects and rejects stale membership at commit", async () => {
    await req("/me/authorization");
    await env.DB.prepare(
      "INSERT INTO teams (id,slug,name,created_at,updated_at) VALUES ('team_a','a','A',1,1)"
    ).run();
    await env.DB.prepare(
      "INSERT INTO team_memberships (team_id,user_id,role,created_at) VALUES ('team_a',?,'member',1)"
    )
      .bind(A)
      .run();
    const project = await create({ ownerTeamId: "team_a" });
    expect((await req(`/projects/${project.id}`, "GET", undefined, B)).status).toBe(404);
    expect(await (await req("/projects", "GET", undefined, B)).json()).toMatchObject({
      projects: [],
    });
    const store = new ProjectStore(env.DB);
    const before = (await store.get(project.id))!;
    await env.DB.prepare("DELETE FROM team_memberships WHERE user_id = ?").bind(A).run();
    await expect(
      store.update(before, { name: "Stale" }, { userId: A, requestId: "race" })
    ).rejects.toThrow("authorization changed");
    expect((await store.get(project.id))?.name).toBe("Billing");
  });
  it("validates slug uniqueness and exclusive targets without modifying sessions", async () => {
    await create();
    expect((await req("/projects", "POST", { name: "Other", slug: "billing" })).status).toBe(409);
    expect(
      (
        await req("/projects", "POST", {
          name: "Other",
          slug: "other",
          defaultEnvironmentId: "env",
          defaultRepoOwner: "a",
          defaultRepoName: "b",
        })
      ).status
    ).toBe(400);
    expect((await env.DB.prepare("SELECT id FROM sessions").all()).results).toHaveLength(0);
  });
  it("edits sources and decisions and omits page-only sources from the preview", async () => {
    const project = await create();
    expect(
      (
        await req(`/projects/${project.id}/sources`, "PUT", {
          sourceType: "url",
          externalIdOrUrl: "https://example.org/secret",
          role: "reference",
          visibility: "page_only",
        })
      ).status
    ).toBe(200);
    expect(
      (
        await req(`/projects/${project.id}/pins`, "PUT", {
          kind: "decision",
          title: "Dual write",
          body: "Until cutover",
          decidedAt: 1,
        })
      ).status
    ).toBe(200);
    const response = await req(`/projects/${project.id}/context/preview`);
    expect(response.status).toBe(200);
    const preview = await response.text();
    expect(preview).toContain("Dual write");
    expect(preview).not.toContain("example.org");
  });
});

describe("project session invariants", () => {
  const session = (id: string, parentSessionId?: string) => ({
    id,
    parentSessionId,
    title: id,
    repoOwner: null,
    repoName: null,
    model: "anthropic/claude-haiku-4-5",
    reasoningEffort: null,
    baseBranch: null,
    status: "created" as const,
    ownerTeamId: null,
    visibility: "workspace" as const,
    userId: A,
    createdAt: 1,
    updatedAt: 1,
  });
  it("atomically persists context and preserves it after association changes", async () => {
    const project = await create({ brief: "Original brief" });
    const store = new SessionIndexStore(env.DB);
    const snapshot = await buildInjectionBlock({
      project: {
        ...project,
        slug: "billing",
        name: "Billing",
        status: "active",
        brief: "Original brief",
      },
      decisions: [],
      links: [],
      sources: [],
      sessions: [],
      memories: [],
      sessionRepositories: [],
    });
    await store.create({
      ...session("snapshot-session"),
      projectId: project.id,
      projectSnapshot: snapshot,
    });
    expect((await store.get("snapshot-session"))?.projectId).toBe(project.id);
    await req(`/projects/${project.id}`, "PATCH", { brief: "Changed" });
    await req("/sessions/snapshot-session/project", "PUT", { projectId: null });
    expect((await new SessionProjectStore(env.DB).snapshot("snapshot-session"))?.text).toContain(
      "Original brief"
    );
    await expect(
      store.create({
        ...session("invalid-project"),
        projectId: "missing",
        projectSnapshot: snapshot,
      })
    ).rejects.toThrow();
    expect(await store.get("invalid-project")).toBeNull();
  });
  it("moves all descendants without changing any other session column", async () => {
    const project = await create();
    const store = new SessionIndexStore(env.DB);
    for (const [id, parent] of [
      ["root", undefined],
      ["child", "root"],
      ["grandchild", "child"],
    ] as const)
      await store.create(session(id, parent));
    const before = (await env.DB.prepare("SELECT * FROM sessions ORDER BY id").all()).results;
    const response = await req("/sessions/root/project", "PUT", {
      projectId: project.id,
      includeChildren: true,
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const after = (await env.DB.prepare("SELECT * FROM sessions ORDER BY id").all()).results;
    expect(after).toEqual(before.map((row) => ({ ...row, project_id: project.id })));
    await req("/sessions/root/project", "PUT", { projectId: null, includeChildren: false });
    expect((await store.get("root"))?.projectId).toBeNull();
    expect((await store.get("child"))?.projectId).toBe(project.id);
  });
  it("refuses the entire subtree if a descendant becomes private", async () => {
    const project = await create();
    const store = new SessionIndexStore(env.DB);
    await req("/me/authorization", "GET", undefined, B);
    await store.create(session("root"));
    await store.create({ ...session("private-child", "root"), userId: B, visibility: "private" });
    const persisted = (await new ProjectStore(env.DB).get(project.id))!;
    await expect(
      new SessionProjectStore(env.DB).associate("root", persisted, true, {
        userId: A,
        requestId: "race",
      })
    ).rejects.toThrow();
    expect((await store.get("root"))?.projectId).toBeNull();
  });
  it("project and unassigned lists partition the fixture", async () => {
    const project = await create();
    const store = new SessionIndexStore(env.DB);
    await store.create({ ...session("assigned"), projectId: project.id });
    await store.create(session("unassigned"));
    const assigned = await (
      await req(`/sessions?projectId=${project.id}`)
    ).json<{ sessions: { id: string }[] }>();
    const unassigned = await (
      await req("/sessions?hasProject=false")
    ).json<{ sessions: { id: string }[] }>();
    expect(assigned.sessions.map((s) => s.id)).toEqual(["assigned"]);
    expect(unassigned.sessions.map((s) => s.id)).toEqual(["unassigned"]);
  });
});

describe("project runtime and visibility boundaries", () => {
  it("binds live context to exactly one sandbox token and records a bounded read", async () => {
    const project = await create({ brief: "Context fixture" });
    const { stub, sessionName } = await initSession({ userId: A });
    await req(`/sessions/${sessionName}/project`, "PUT", { projectId: project.id });
    await seedSandboxAuth(stub, {
      authToken: "project-sandbox-token",
      sandboxId: "project-sandbox",
    });
    const url = `https://test.local/sessions/${sessionName}/project-context`;
    expect((await req(`/sessions/${sessionName}/project-context`)).status).toBe(401);
    const response = await SELF.fetch(url, {
      headers: { Authorization: "Bearer project-sandbox-token" },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    const context = await response.json<{ brief: string; budget: { bytes: number } }>();
    expect(context.brief).toBe("Context fixture");
    expect(context.budget.bytes).toBeLessThanOrEqual(65536);
    const events = await queryDO<{ type: string }>(
      stub,
      "SELECT type FROM events WHERE type = 'project_context.read'"
    );
    expect(events).toHaveLength(1);
    const other = await initSession({ userId: A });
    await seedSandboxAuth(other.stub, { authToken: "another-token", sandboxId: "another-sandbox" });
    expect(
      (
        await SELF.fetch(`https://test.local/sessions/${other.sessionName}/project-context`, {
          headers: { Authorization: "Bearer project-sandbox-token" },
        })
      ).status
    ).toBe(401);
    await env.DB.prepare("UPDATE users SET suspended_at = 1 WHERE id = ?").bind(A).run();
    expect(
      (await SELF.fetch(url, { headers: { Authorization: "Bearer project-sandbox-token" } })).status
    ).toBe(404);
  });
  it("reads only the latest completed turn's final assistant token, never prompts or tool output", async () => {
    await req("/me/authorization");
    const { stub, sessionName } = await initSession({ userId: A });
    const [{ id: authorId }] = await queryDO<{ id: string }>(
      stub,
      "SELECT id FROM participants LIMIT 1"
    );
    await seedMessage(stub, {
      id: "complete",
      authorId,
      content: "SECRET USER PROMPT",
      source: "web",
      status: "completed",
      createdAt: 100,
    });
    await seedMessage(stub, {
      id: "pending",
      authorId,
      content: "SECRET CURRENT PROMPT",
      source: "web",
      status: "pending",
      createdAt: 200,
    });
    await seedEvents(stub, [
      {
        id: "old",
        type: "token",
        data: JSON.stringify({ content: "SECRET EARLY NARRATION" }),
        messageId: "complete",
        createdAt: 101,
      },
      {
        id: "tool",
        type: "tool_call",
        data: JSON.stringify({ result: "SECRET TOOL" }),
        messageId: "complete",
        createdAt: 102,
      },
      {
        id: "final",
        type: "token",
        data: JSON.stringify({ content: "F".repeat(40000) }),
        messageId: "complete",
        createdAt: 103,
      },
      {
        id: "pending-token",
        type: "token",
        data: JSON.stringify({ content: "SECRET PENDING" }),
        messageId: "pending",
        createdAt: 201,
      },
    ]);
    const response = await req(`/sessions/${sessionName}/reference-summary`);
    expect(response.status, await response.clone().text()).toBe(200);
    const payload = await response.text();
    expect(payload).not.toContain("SECRET");
    expect(payload.length).toBeLessThanOrEqual(4000);
    expect(JSON.parse(payload).finalAssistantExcerpt).toBe("F".repeat(2000));
    await env.DB.prepare("UPDATE sessions SET visibility = 'private' WHERE id = ?")
      .bind(sessionName)
      .run();
    expect(
      (await req(`/sessions/${sessionName}/reference-summary`, "GET", undefined, B)).status
    ).toBe(404);
  });
  it("filters board, PR and analytics projections before aggregation", async () => {
    const project = await create();
    await req("/me/authorization", "GET", undefined, B);
    const store = new SessionIndexStore(env.DB);
    const base = {
      repoOwner: null,
      repoName: null,
      model: "anthropic/claude-haiku-4-5",
      reasoningEffort: null,
      baseBranch: null,
      status: "completed" as const,
      ownerTeamId: null,
      visibility: "workspace" as const,
      userId: A,
      createdAt: 100,
      updatedAt: 100,
      projectId: project.id,
    };
    await store.create({ ...base, id: "public-work", title: "Public" });
    await store.create({
      ...base,
      id: "secret-work",
      title: "SECRET",
      userId: B,
      visibility: "private",
    });
    const board = await req(`/projects/${project.id}/sessions?bucket=board`);
    expect(board.status, await board.clone().text()).toBe(200);
    expect(await board.text()).not.toContain("SECRET");
    const analytics = new AnalyticsStore(env.DB, await projectViewer(env.DB, A), "on");
    const filters = { startAt: 0, endAt: 1000, scope: "all" as const };
    const projects = await analytics.getBreakdown(filters, "project");
    const users = await analytics.getBreakdown(filters, "user");
    expect(projects.entries.reduce((total, item) => total + item.sessions, 0)).toBe(
      users.entries.reduce((total, item) => total + item.sessions, 0)
    );
    expect(projects.entries).toMatchObject([
      { key: project.id, displayName: "Billing", sessions: 1 },
    ]);
  });
  it("rolls back automation edits when the executor loses project access before commit", async () => {
    const project = await create();
    const response = await req("/automations", "POST", {
      name: "Project job",
      instructions: "Check project",
      triggerType: "schedule",
      scheduleCron: "0 0 * * *",
      scheduleTz: "UTC",
      projectId: project.id,
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const { automation } = await response.json<{ automation: { id: string; projectId: string } }>();
    expect(automation.projectId).toBe(project.id);
    await env.DB.prepare("UPDATE users SET suspended_at = 1 WHERE id = ?").bind(A).run();
    await expect(
      sqlDatabase(env.DB).batch([
        env.DB.prepare("UPDATE automations SET name = 'Must rollback' WHERE id = ?").bind(
          automation.id
        ),
        projectSubscriptionReceipt(
          env.DB,
          { userId: A, requestId: "revoked" },
          automation.id,
          project.id,
          project.id,
          A
        ),
      ])
    ).rejects.toThrow();
    expect(
      await env.DB.prepare("SELECT name FROM automations WHERE id = ?")
        .bind(automation.id)
        .first("name")
    ).toBe("Project job");
  });
});

it("rolls session and immutable context back when a later batch statement fails", async () => {
  const project = await create();
  const db = sqlDatabase(env.DB);
  const store = new SessionIndexStore({
    prepare: db.prepare.bind(db),
    batch: (statements) =>
      db.batch([
        ...statements,
        db.prepare("INSERT INTO projects (id) VALUES ('intentional-invalid-row')"),
      ]),
  });
  const snapshot = await buildInjectionBlock({
    project: {
      id: project.id,
      slug: "billing",
      name: "Billing",
      status: "active",
      brief: "Must rollback",
    },
    decisions: [],
    links: [],
    sources: [],
    sessions: [],
    memories: [],
    sessionRepositories: [],
  });
  await expect(
    store.create({
      id: "rollback-session",
      title: null,
      repoOwner: null,
      repoName: null,
      model: "anthropic/claude-haiku-4-5",
      reasoningEffort: null,
      baseBranch: null,
      status: "created",
      ownerTeamId: null,
      visibility: "workspace",
      userId: A,
      createdAt: 1,
      updatedAt: 1,
      projectId: project.id,
      projectSnapshot: snapshot,
    })
  ).rejects.toThrow();
  expect(await new SessionIndexStore(db).get("rollback-session")).toBeNull();
  expect(await new SessionProjectStore(db).snapshot("rollback-session")).toBeNull();
});

it("does not grant session visibility to a custom project-only role", async () => {
  const project = await create();
  await req("/me/authorization", "GET", undefined, B);
  const store = new SessionIndexStore(env.DB);
  await store.create({
    id: "project-only-hidden",
    title: "SECRET SESSION",
    repoOwner: null,
    repoName: null,
    model: "anthropic/claude-haiku-4-5",
    reasoningEffort: null,
    baseBranch: null,
    status: "created",
    ownerTeamId: null,
    visibility: "workspace",
    userId: A,
    createdAt: 1,
    updatedAt: 1,
    projectId: project.id,
  });
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO roles (id,name,normalized_name) VALUES ('project_reader','Project Reader','project reader')"
    ),
    env.DB.prepare(
      "INSERT INTO role_permissions (role_id,permission_id) VALUES ('project_reader','projects.read')"
    ),
    env.DB.prepare(
      "UPDATE user_role_assignments SET role_id = 'project_reader' WHERE user_id = ?"
    ).bind(B),
  ]);
  expect((await req(`/projects/${project.id}`, "GET", undefined, B)).status).toBe(200);
  expect((await req(`/projects/${project.id}/sessions`, "GET", undefined, B)).status).toBe(403);
  const context = await loadProjectContext(env.DB, project.id, await projectViewer(env.DB, B));
  expect(context?.sessions).toEqual([]);
});

it("creates the immutable project snapshot through the authenticated session API", async () => {
  const project = await create({ brief: "Creation-time brief" });
  const response = await req("/sessions", "POST", {
    title: "Project session",
    projectId: project.id,
  });
  expect(response.status, await response.clone().text()).toBe(201);
  const { sessionId } = await response.json<{ sessionId: string }>();
  expect(await new SessionIndexStore(env.DB).get(sessionId)).toMatchObject({
    projectId: project.id,
    userId: A,
  });
  const snapshot = await new SessionProjectStore(env.DB).snapshot(sessionId);
  expect(snapshot?.text).toContain("Creation-time brief");
  // Explicit No repository must not be replaced by the project target default.
  await env.DB.prepare(
    "UPDATE projects SET default_repo_owner = 'acme', default_repo_name = 'private-target' WHERE id = ?"
  )
    .bind(project.id)
    .run();
  const noRepo = await req("/sessions", "POST", {
    projectId: project.id,
    repoOwner: null,
    repoName: null,
  });
  expect(noRepo.status, await noRepo.clone().text()).toBe(201);
  const { sessionId: noRepoId } = await noRepo.json<{ sessionId: string }>();
  expect(await new SessionIndexStore(env.DB).get(noRepoId)).toMatchObject({
    repoOwner: null,
    repoName: null,
    projectId: project.id,
  });

  expect(snapshot?.bytes).toBe(new TextEncoder().encode(snapshot!.text).length);
  await req(`/projects/${project.id}`, "PATCH", { brief: "Later brief" });
  expect((await new SessionProjectStore(env.DB).snapshot(sessionId))?.text).toBe(snapshot!.text);
});

it.each([
  { source: "manual", teamId: null },
  { source: "schedule", teamId: null },
  { source: "manual", teamId: "team_projects" },
  { source: "schedule", teamId: "team_projects" },
])(
  "launches a $source automation for $teamId with a fresh project snapshot",
  async ({ source, teamId }) => {
    if (teamId) {
      await req("/me/authorization");
      await env.DB.prepare(
        "INSERT INTO teams (id,slug,name,default_visibility,created_at,updated_at) VALUES (?,'projects','Projects','private',1,1)"
      )
        .bind(teamId)
        .run();
      await env.DB.prepare(
        "INSERT INTO team_memberships (team_id,user_id,role,created_at) VALUES (?,?,'member',1)"
      )
        .bind(teamId, A)
        .run();
    }
    const project = await create({ brief: "Automation context", ownerTeamId: teamId });
    const response = await req("/automations", "POST", {
      name: "Project automation",
      instructions: "Check project",
      triggerType: "schedule",
      scheduleCron: "0 0 * * *",
      scheduleTz: "UTC",
      projectId: project.id,
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const { automation } = await response.json<{ automation: { id: string } }>();
    const sessionFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (new URL(request.url).pathname === "/internal/init")
        return Response.json({ status: "ok" });
      if (new URL(request.url).pathname === "/internal/prompt")
        return Response.json({ messageId: "project-auto-msg", status: "queued" });
      return new Response("Not Found", { status: 404 });
    });
    const schedulerEnv = createCloudflareEnv({
      ...env,
      SESSION: {
        idFromName: (name: string) => name,
        get: () => ({ fetch: sessionFetch }),
      } as unknown as DurableObjectNamespace,
    });
    const scheduler = new Scheduler(sqlDatabase(env.DB), schedulerEnv, { submit() {} });
    if (source === "manual") await scheduler.trigger(automation.id, A);
    else {
      await env.DB.prepare("UPDATE automations SET next_run_at = ? WHERE id = ?")
        .bind(Date.now() - 1000, automation.id)
        .run();
      await scheduler.tick();
    }
    const session = await env.DB.prepare(
      "SELECT id,project_id,user_id,owner_team_id,visibility FROM sessions WHERE automation_id = ?"
    )
      .bind(automation.id)
      .first<{ id: string; project_id: string; user_id: string }>();
    expect(session).toMatchObject({
      project_id: project.id,
      user_id: A,
      owner_team_id: teamId,
      visibility: teamId ? "private" : "workspace",
    });
    expect((await new SessionProjectStore(env.DB).snapshot(session!.id))?.text).toContain(
      "Automation context"
    );
  }
);

it("rejects a terminal descendant in another team without partially moving the root", async () => {
  await req("/me/authorization");
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO teams (id,slug,name,created_at,updated_at) VALUES ('project_team','project-team','Project team',1,1)"
    ),
    env.DB.prepare(
      "INSERT INTO team_memberships (team_id,user_id,role,created_at) VALUES ('project_team',?,'lead',1)"
    ).bind(A),
  ]);
  const project = await create();
  const store = new SessionIndexStore(env.DB);
  const base = {
    title: null,
    repoOwner: null,
    repoName: null,
    model: "anthropic/claude-haiku-4-5",
    reasoningEffort: null,
    baseBranch: null,
    status: "completed" as const,
    ownerTeamId: null,
    visibility: "workspace" as const,
    userId: A,
    createdAt: 1,
    updatedAt: 1,
  };
  await store.create({ ...base, id: "team-root" });
  await store.create({
    ...base,
    id: "team-terminal",
    parentSessionId: "team-root",
    ownerTeamId: "project_team",
    visibility: "team",
  });
  const response = await req("/sessions/team-root/project", "PUT", {
    projectId: project.id,
    includeChildren: true,
  });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: "project_team_mismatch" });
  expect((await store.get("team-root"))?.projectId).toBeNull();
  expect((await store.get("team-terminal"))?.projectId).toBeNull();
});

it("keeps the board lane correct when an open PR falls outside the bounded display list", async () => {
  const project = await create();
  await new SessionIndexStore(env.DB).create({
    id: "long-pr-history",
    title: "Long history",
    repoOwner: null,
    repoName: null,
    model: "anthropic/claude-haiku-4-5",
    reasoningEffort: null,
    baseBranch: null,
    status: "completed",
    ownerTeamId: null,
    visibility: "workspace",
    userId: A,
    createdAt: 1,
    updatedAt: 1,
    projectId: project.id,
  });
  await env.DB.prepare(
    `WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n < 501)
 INSERT INTO session_pull_requests (artifact_id,session_id,repo_owner,repo_name,pr_number,url,lifecycle_state,is_draft,head_branch,base_branch,provider_updated_at,created_at,updated_at)
 SELECT 'history-' || n,'long-pr-history','acme','app',n,'https://example.test/pr/' || n,CASE WHEN n=1 THEN 'open' ELSE 'closed' END,0,'feature','main',n,n,n FROM numbers`
  ).run();
  const response = await req(`/projects/${project.id}/sessions?bucket=board`);
  expect(response.status, await response.clone().text()).toBe(200);
  const board = await response.json<{
    items: { lane: string; pullRequests: { state: string }[] }[];
  }>();
  expect(board.items[0].pullRequests).toHaveLength(500);
  expect(board.items[0].pullRequests.every((pr) => pr.state === "closed")).toBe(true);
  expect(board.items[0].lane).toBe("open");
});

it("rejects a project subscription that differs from explicit automation ownership", async () => {
  await req("/me/authorization");
  await env.DB.prepare(
    "INSERT INTO teams (id,slug,name,created_at,updated_at) VALUES ('team_projects','projects','Projects',1,1)"
  ).run();
  await env.DB.prepare(
    "INSERT INTO team_memberships (team_id,user_id,role,created_at) VALUES ('team_projects',?,'member',1)"
  )
    .bind(A)
    .run();
  const project = await create({ ownerTeamId: "team_projects" });
  const response = await req("/automations", "POST", {
    name: "Wrong team",
    instructions: "Do not launch",
    triggerType: "schedule",
    scheduleCron: "0 0 * * *",
    scheduleTz: "UTC",
    teamId: null,
    projectId: project.id,
  });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: "project_team_mismatch" });
  expect((await env.DB.prepare("SELECT id FROM automations").all()).results).toHaveLength(0);
});

it.each(["associated", "unassigned", "reassigned"])(
  "withholds protected historical snapshot content when %s",
  async (association) => {
    const project = await create({ brief: "Protected creation brief" });
    const response = await req("/sessions", "POST", {
      projectId: project.id,
      repoOwner: null,
      repoName: null,
    });
    expect(response.status).toBe(201);
    const { sessionId } = await response.json<{ sessionId: string }>();
    expect(await (await req(`/sessions/${sessionId}/project-snapshot`)).json()).toMatchObject({
      snapshot: { text: expect.stringContaining("Protected creation brief") },
    });
    if (association !== "associated") {
      const next =
        association === "reassigned" ? await create({ slug: "other", name: "Other" }) : null;
      expect(
        (await req(`/sessions/${sessionId}/project`, "PUT", { projectId: next?.id ?? null })).status
      ).toBe(200);
    }
    await req("/me/authorization", "GET", undefined, B);
    await env.DB.prepare(
      "INSERT INTO roles (id,name,normalized_name,is_system) VALUES ('snapshot-reader','Snapshot reader','snapshot reader',0)"
    ).run();
    await env.DB.prepare(
      "INSERT INTO role_permissions (role_id,permission_id) VALUES ('snapshot-reader','sessions.read')"
    ).run();
    await env.DB.prepare(
      "UPDATE user_role_assignments SET role_id='snapshot-reader' WHERE user_id=?"
    )
      .bind(B)
      .run();
    const restricted = await req(`/sessions/${sessionId}/project-snapshot`, "GET", undefined, B);
    expect(restricted.status).toBe(200);
    expect(await restricted.json()).toMatchObject({ snapshot: null });
    expect((await new SessionProjectStore(env.DB).snapshot(sessionId))?.text).toContain(
      "Protected creation brief"
    );
  }
);

it("stores audit identifiers and changed fields without protected project content", async () => {
  const project = await create({ name: "Protected name", brief: "Original protected brief" });
  await req(`/projects/${project.id}`, "PATCH", { brief: "Updated protected brief" });
  await req(`/projects/${project.id}/sources`, "PUT", {
    sourceType: "url",
    externalIdOrUrl: "https://private.example/secret",
    title: "Protected source",
    role: "reference",
  });
  await req(`/projects/${project.id}/pins`, "PUT", {
    kind: "decision",
    title: "Protected decision",
    body: "Confidential decision body",
    decidedAt: 1,
  });
  const { results } = await env.DB.prepare(
    "SELECT action,metadata_json FROM authorization_audit_events WHERE resource_type='project'"
  ).all<{ action: string; metadata_json: string }>();
  expect(results).toHaveLength(4);
  const serialized = JSON.stringify(results);
  for (const value of [
    "Protected name",
    "Original protected brief",
    "Updated protected brief",
    "private.example",
    "Protected source",
    "Protected decision",
    "Confidential decision body",
  ])
    expect(serialized).not.toContain(value);
  expect(
    JSON.parse(results.find((row) => row.action === "project.updated")!.metadata_json).changedFields
  ).toContain("brief");
  expect(
    JSON.parse(results.find((row) => row.action === "project.created")!.metadata_json).after
  ).toEqual({ id: project.id });
});

it.each([
  { source: "private", destination: "workspace", otherTeam: false, allowed: false },
  { source: "private", destination: "private", otherTeam: false, allowed: false },
  { source: "team", destination: "workspace", otherTeam: false, allowed: false },
  { source: "team", destination: "team", otherTeam: true, allowed: false },
  { source: "team", destination: "team", otherTeam: false, allowed: true },
  { source: "workspace", destination: "private", otherTeam: false, allowed: true },
] as const)(
  "checks reference audience $source to $destination (other team: $otherTeam)",
  async ({ source, destination, otherTeam, allowed }) => {
    await req("/me/authorization");
    for (const team of ["team_refs", "team_other"]) {
      await env.DB.prepare(
        "INSERT INTO teams (id,slug,name,created_at,updated_at) VALUES (?,?,?,1,1)"
      )
        .bind(team, team, team)
        .run();
      await env.DB.prepare(
        "INSERT INTO team_memberships (team_id,user_id,role,created_at) VALUES (?,?,'member',1)"
      )
        .bind(team, A)
        .run();
    }
    const store = new SessionIndexStore(env.DB);
    const base = {
      repoOwner: null,
      repoName: null,
      model: "anthropic/claude-haiku-4-5",
      reasoningEffort: null,
      baseBranch: null,
      status: "created" as const,
      userId: A,
      createdAt: 1,
      updatedAt: 1,
    };
    await store.create({
      ...base,
      id: "ref-source",
      title: "Protected title",
      visibility: source,
      ownerTeamId: source === "team" ? "team_refs" : null,
    });
    await store.create({
      ...base,
      id: "ref-destination",
      title: "Destination",
      visibility: destination,
      ownerTeamId: destination === "team" ? (otherTeam ? "team_other" : "team_refs") : null,
    });
    const fetch = vi.fn(async () => Response.json({ finalAssistantExcerpt: "Protected answer" }));
    const result = resolvePromptReferences(
      env.DB,
      { fetch },
      A,
      "#[Work](session:ref-source)",
      "ref-destination"
    );
    if (allowed) {
      expect(await result).toContain("Protected answer");
      expect(fetch).toHaveBeenCalledOnce();
    } else {
      await expect(result).rejects.toThrow("audience is incompatible");
      expect(fetch).not.toHaveBeenCalled();
    }
  }
);

it.each(["private", "workspace"])(
  "omits private siblings from live context in a %s session",
  async (visibility) => {
    const project = await create();
    const { stub, sessionName } = await initSession({ userId: A });
    await req(`/sessions/${sessionName}/project`, "PUT", { projectId: project.id });
    await env.DB.prepare("UPDATE sessions SET visibility=? WHERE id=?")
      .bind(visibility, sessionName)
      .run();
    const sibling = await initSession({ userId: A });
    await req(`/sessions/${sibling.sessionName}/project`, "PUT", { projectId: project.id });
    await env.DB.prepare(
      "UPDATE sessions SET visibility='private', title='Private sibling secret' WHERE id=?"
    )
      .bind(sibling.sessionName)
      .run();
    await req(`/projects/${project.id}/sources`, "PUT", {
      sourceType: "session",
      externalIdOrUrl: sibling.sessionName,
      title: "Private source secret",
      role: "reference",
    });
    await seedSandboxAuth(stub, {
      authToken: "private-context-token",
      sandboxId: "private-context-sandbox",
    });
    const response = await SELF.fetch(
      `https://test.local/sessions/${sessionName}/project-context`,
      { headers: { Authorization: "Bearer private-context-token" } }
    );
    expect(response.status).toBe(200);
    const content = await response.text();
    expect(content).not.toContain(sibling.sessionName);
    expect(content).not.toContain("Private sibling secret");
    expect(content).not.toContain("Private source secret");
  }
);

it("partitions multi-project inbox pages, snapshots, and project boards", async () => {
  const first = await create();
  const second = await create({ name: "Other", slug: "other" });
  const store = new SessionIndexStore(env.DB);
  const base = {
    repoOwner: null,
    repoName: null,
    model: "anthropic/claude-haiku-4-5",
    reasoningEffort: null,
    baseBranch: null,
    status: "created" as const,
    userId: A,
    ownerTeamId: null,
    visibility: "workspace" as const,
    createdAt: 1,
    updatedAt: 1,
  };
  for (const [id, projectId] of [
    ["first-project", first.id],
    ["second-project", second.id],
    ["no-project", null],
  ] as const)
    await store.create({ ...base, id, title: id, projectId });
  for (const [filters, expected] of [
    [{ projectId: first.id }, "first-project"],
    [{ projectId: second.id }, "second-project"],
    [{ hasProject: false }, "no-project"],
  ] as const) {
    const inbox = new SessionInboxStore(env.DB);
    const options = {
      ...filters,
      viewerUserId: A,
      readScope: await projectViewer(env.DB, A),
      mode: "on" as const,
      limit: 10,
    };
    const snapshot = await inbox.snapshot(options);
    expect(
      Object.values(snapshot).flatMap((page) => page.items.map((item) => item.rootSession.id))
    ).toEqual([expected]);
    const response = await req(
      `/sessions/inbox?category=finished&${"projectId" in filters ? `projectId=${filters.projectId}` : "hasProject=false"}`
    );
    expect(response.status).toBe(200);
    const page = await response.json<{ items: { rootSession: { id: string } }[] }>();
    expect(page.items.map((item) => item.rootSession.id)).toEqual([expected]);
  }
  const board = await (
    await req(`/projects/${first.id}/sessions?bucket=board`)
  ).json<{ items: { rootSession: { id: string } }[] }>();
  expect(board.items.map((item) => item.rootSession.id)).toEqual(["first-project"]);
});

it("advances the project version for same-millisecond item saves and deletes", async () => {
  const { id } = await create();
  const store = new ProjectStore(env.DB);
  const before = (await store.get(id))!;
  const actor = { userId: A, requestId: "monotonic" };
  const clock = vi.spyOn(Date, "now").mockReturnValue(before.updatedAt);
  try {
    const sourceId = await store.putSource(
      before,
      projectSourceInputSchema.parse({
        sourceType: "url",
        externalIdOrUrl: "https://example.org",
        role: "reference",
      }),
      actor
    );
    const pinId = await store.putPin(
      before,
      projectPinInputSchema.parse({
        kind: "decision",
        title: "Decision",
        body: "Body",
        decidedAt: 1,
      }),
      actor
    );
    expect((await store.get(id))?.updatedAt).toBe(before.updatedAt + 2);
    await expect(store.update(before, { name: "Stale edit" }, actor)).rejects.toThrow("changed");
    const beforeDelete = (await store.get(id))!;
    await store.deleteItem(beforeDelete, "source", sourceId, actor);
    await store.deleteItem(beforeDelete, "pin", pinId, actor);
    expect((await store.get(id))?.updatedAt).toBe(before.updatedAt + 4);
    await expect(store.update(beforeDelete, { name: "Stale delete edit" }, actor)).rejects.toThrow(
      "changed"
    );
  } finally {
    clock.mockRestore();
  }
});

it("rejects a project-revoked executor before recording an invocation", async () => {
  const project = await create();
  const response = await req("/automations", "POST", {
    name: "Revoked",
    instructions: "Check",
    triggerType: "schedule",
    scheduleCron: "0 0 * * *",
    scheduleTz: "UTC",
    projectId: project.id,
  });
  expect(response.status).toBe(201);
  const { automation } = await response.json<{ automation: { id: string } }>();
  await env.DB.prepare(
    "INSERT INTO roles (id,name,normalized_name,is_system) VALUES ('executor-no-project','Executor no project','executor no project',0)"
  ).run();
  await env.DB.prepare(
    "INSERT INTO role_permissions (role_id,permission_id) VALUES ('executor-no-project','sessions.create')"
  ).run();
  await env.DB.prepare(
    "UPDATE user_role_assignments SET role_id='executor-no-project' WHERE user_id=?"
  )
    .bind(A)
    .run();
  const scheduler = new Scheduler(sqlDatabase(env.DB), createCloudflareEnv(env), { submit() {} });
  await expect(scheduler.trigger(automation.id, A)).rejects.toMatchObject({
    name: "AutomationExecutionUnauthorizedError",
  });
  expect(
    (await env.DB.prepare("SELECT id FROM automation_invocations").all()).results
  ).toHaveLength(0);
  expect((await env.DB.prepare("SELECT id FROM automation_runs").all()).results).toHaveLength(0);
});

it("paginates project lists past 200 with stable timestamp ties and team scoping", async () => {
  await req("/me/authorization");
  await env.DB.batch(
    Array.from({ length: 205 }, (_, i) =>
      env.DB.prepare(
        "INSERT INTO projects (id,slug,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,?,1,1)"
      ).bind(`page-${String(i).padStart(3, "0")}`, `page-${i}`, `Page ${i}`, A)
    )
  );
  const first = await (
    await req("/projects?teamId=null")
  ).json<{ projects: { id: string }[]; hasMore: boolean; nextCursor: string }>();
  expect(first.projects).toHaveLength(200);
  expect(first.hasMore).toBe(true);
  const next = await (
    await req(`/projects?teamId=null&cursor=${encodeURIComponent(first.nextCursor)}`)
  ).json<{ projects: { id: string }[]; hasMore: boolean }>();
  expect(next.projects).toHaveLength(5);
  expect(next.hasMore).toBe(false);
  expect(new Set([...first.projects, ...next.projects].map((project) => project.id)).size).toBe(
    205
  );
  expect((await req("/projects?cursor=invalid")).status).toBe(400);
});

it.each(["actor", "executor"])(
  "reauthorizes retained project subscriptions for the %s",
  async (revoked) => {
    const project = await create();
    const response = await req("/automations", "POST", {
      name: "Retained",
      instructions: "Check",
      triggerType: "schedule",
      scheduleCron: "0 0 * * *",
      scheduleTz: "UTC",
      projectId: project.id,
    });
    expect(response.status).toBe(201);
    const { automation } = await response.json<{ automation: { id: string } }>();
    await req("/me/authorization", "GET", undefined, B);
    await env.DB.prepare(
      "INSERT INTO roles (id,name,normalized_name,is_system) VALUES ('manage-no-project','Manage no project','manage no project',0)"
    ).run();
    await env.DB.prepare(
      "INSERT INTO role_permissions (role_id,permission_id) VALUES ('manage-no-project','automations.manage.any'),('manage-no-project','automations.read')"
    ).run();
    await env.DB.prepare(
      "UPDATE user_role_assignments SET role_id='manage-no-project' WHERE user_id=?"
    )
      .bind(revoked === "actor" ? B : A)
      .run();
    const edit = await req(
      `/automations/${automation.id}`,
      "PUT",
      { instructions: "Changed" },
      revoked === "actor" ? B : A
    );
    expect(edit.status, await edit.clone().text()).toBe(403);
    expect(
      await env.DB.prepare("SELECT instructions FROM automations WHERE id=?")
        .bind(automation.id)
        .first("instructions")
    ).toBe("Check");
    const detach = await req(
      `/automations/${automation.id}`,
      "PUT",
      { projectId: null },
      revoked === "actor" ? B : A
    );
    expect(detach.status, await detach.clone().text()).toBe(200);
  }
);

it("resolves and commits canonical repository defaults against current team grants", async () => {
  await req("/me/authorization");
  await env.DB.prepare(
    "INSERT INTO teams (id,slug,name,created_at,updated_at) VALUES ('repo-team','repo-team','Repositories',1,1)"
  ).run();
  await env.DB.prepare(
    "INSERT INTO team_memberships (team_id,user_id,role,created_at) VALUES ('repo-team',?,'member',1)"
  )
    .bind(A)
    .run();
  await env.DB.prepare(
    "INSERT INTO team_repository_grants (id,team_id,grant_kind,repo_external_id,repo_owner,repo_name,created_at) VALUES ('grant','repo-team','repository',123,'acme','web',1)"
  ).run();
  const resolve = vi
    .spyOn(GitHubSourceControlProvider.prototype, "checkRepositoryAccess")
    .mockResolvedValue({ repoId: 123, repoOwner: "acme", repoName: "web", defaultBranch: "main" });
  const input = {
    name: "Default repo",
    slug: "default-repo",
    ownerTeamId: "repo-team",
    defaultRepoOwner: "Acme",
    defaultRepoName: "Web",
  };
  const send = async (body: object) => {
    const url = "https://test.local/projects";
    const init = {
      method: "POST",
      body: JSON.stringify(body),
      as: { userId: A, role: "member" as const },
    };
    return routeRequest(
      new Request(url, { ...init, headers: await serviceRequestHeaders(url, init) }),
      env,
      createExecutionContext()
    );
  };
  try {
    const response = await send(input);
    expect(response.status, await response.clone().text()).toBe(201);
    const { project } = await response.json<{ project: { id: string; defaultRepoId: number } }>();
    expect(project.defaultRepoId).toBe(123);
    const store = new ProjectStore(env.DB);
    const before = (await store.get(project.id))!;
    await env.DB.prepare("DELETE FROM team_repository_grants").run();
    await expect(
      store.update(before, { brief: "Stale grant" }, { userId: A, requestId: "revoked" })
    ).rejects.toThrow("authorization changed");
    expect((await store.get(project.id))?.brief).toBeNull();
    await expect(
      store.create(
        { ...input, slug: "revoked", defaultRepoId: 123 },
        { userId: A, requestId: "revoked-create" }
      )
    ).rejects.toThrow("authorization changed");
    await env.DB.prepare(
      "INSERT INTO team_repository_grants (id,team_id,grant_kind,created_at) VALUES ('installation','repo-team','installation',1)"
    ).run();
    resolve.mockResolvedValueOnce(null);
    expect((await send({ ...input, slug: "missing" })).status).toBe(404);
  } finally {
    resolve.mockRestore();
  }
});

it("loads large project context with bounded queries and skips live data for snapshots", async () => {
  const project = await create();
  const store = new SessionIndexStore(env.DB);
  for (let i = 0; i < 20; i++)
    await store.create({
      id: `context-${i}`,
      title: `Context ${i}`,
      repoOwner: null,
      repoName: null,
      model: "anthropic/claude-haiku-4-5",
      reasoningEffort: null,
      baseBranch: null,
      status: "created",
      userId: A,
      createdAt: 1,
      updatedAt: 1,
      projectId: project.id,
      ownerTeamId: null,
      visibility: "workspace",
    });
  await env.DB.batch(
    Array.from({ length: 200 }, (_, i) =>
      env.DB.prepare(
        "INSERT INTO project_context_sources (id,project_id,source_type,external_id_or_url,role,refresh_policy,provenance,visibility,position,created_by,created_at,updated_at) VALUES (?,?,'session',?,'reference','manual','user','agent',?,?,1,1)"
      ).bind(`source-${i}`, project.id, `context-${i}`, i, A)
    )
  );
  const viewer = await projectViewer(env.DB, A);
  const db = sqlDatabase(env.DB);
  const queries: string[] = [];
  const measured = {
    prepare(sql: string) {
      queries.push(sql);
      return db.prepare(sql);
    },
    batch: db.batch.bind(db),
  };
  const snapshot = await loadProjectSnapshotContext(measured, project.id, viewer);
  expect(queries).toHaveLength(4);
  expect(queries.join(" ")).not.toContain("session_pull_requests");
  expect(snapshot?.sources).toHaveLength(20);
  expect(snapshot?.sessions).toEqual([]);
  queries.length = 0;
  const live = await loadProjectContext(measured, project.id, viewer);
  expect(queries).toHaveLength(6);
  expect(live?.sessions).toHaveLength(20);
  expect(live?.sources).toEqual(snapshot?.sources);
  expect((await buildInjectionBlock(live!)).text).toBe((await buildInjectionBlock(snapshot!)).text);
});
