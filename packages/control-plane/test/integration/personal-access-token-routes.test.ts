/**
 * The routes that accept personal access tokens, through the deployed Worker against real D1 and
 * the session Durable Object: each reads or writes as the token's owner, within the token's grant,
 * and the neighbouring routes that do not accept tokens refuse them.
 */

import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PermissionId } from "@open-inspect/shared/rbac";
import { AutomationStore } from "../../src/db/automation-store";
import { PersonalAccessTokenStore } from "../../src/db/personal-access-tokens";
import { SessionIndexStore } from "../../src/db/session-index";
import { cleanD1Tables } from "./cleanup";
import { initSession, seedActiveUser, seedEvents } from "./helpers";
import { fetchRuns } from "./run-helpers";
import { seedEnvironment } from "./ownership-test-helpers";

const BASE = "https://cp.test";
const OWNER = "77777777777777777777777777777777";
const OTHER = "88888888888888888888888888888888";
const ADMIN = "99999999999999999999999999999999";

async function issueToken(userId: string, permissions: PermissionId[]): Promise<string> {
  const result = await new PersonalAccessTokenStore(env.DB).issue({
    userId,
    name: "integration",
    permissions,
    expiresAt: Date.now() + 60 * 60 * 1000,
    now: Date.now(),
    requestId: "integration",
  });
  if (result.kind !== "issued") throw new Error("token was not issued");
  return result.token.token;
}

function withToken(token: string, path: string, init: { method?: string; body?: unknown } = {}) {
  return SELF.fetch(`${BASE}${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

async function saveAutomation(id: string, userId: string) {
  await env.DB.prepare(
    `INSERT INTO automations
       (id, name, instructions, schedule_cron, model, created_by, user_id, created_at, updated_at)
     VALUES (?, ?, 'Run tests', '0 9 * * *', 'anthropic/claude-sonnet-4-6', ?, ?, 1, 1)`
  )
    .bind(id, id, userId, userId)
    .run();
}

async function invocationActorKinds(automationId: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT actor_kind FROM automation_invocations WHERE automation_id = ? ORDER BY created_at"
  )
    .bind(automationId)
    .all<{ actor_kind: string }>();
  return results.map((row) => row.actor_kind);
}

async function expectRefusal(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  await expect(response.json()).resolves.toMatchObject({ code });
}

beforeEach(async () => {
  await cleanD1Tables();
  // Members by the default role assignment; ADMIN is promoted.
  for (const userId of [OWNER, OTHER, ADMIN]) await seedActiveUser(userId);
  await env.DB.prepare(
    "UPDATE user_role_assignments SET role_id = 'role_builtin_administrator' WHERE user_id = ?"
  )
    .bind(ADMIN)
    .run();
});
afterEach(cleanD1Tables);

describe("reading sessions with a token", () => {
  it("lists, reads events and messages, and needs sessions.read to do so", async () => {
    const { stub, sessionName } = await initSession({ userId: OWNER });
    await seedEvents(stub, [
      { id: "event-1", type: "token", data: JSON.stringify({ text: "hi" }), createdAt: 1 },
    ]);
    const reader = await issueToken(OWNER, ["sessions.read"]);

    const list = await withToken(reader, "/sessions");
    expect(list.status).toBe(200);
    const { sessions } = await list.json<{ sessions: { id: string }[] }>();
    expect(sessions.map((session) => session.id)).toContain(sessionName);

    const events = await withToken(reader, `/sessions/${sessionName}/events`);
    expect(events.status).toBe(200);
    expect(JSON.stringify(await events.json())).toContain("event-1");
    expect((await withToken(reader, `/sessions/${sessionName}/messages`)).status).toBe(200);

    const unrelated = await issueToken(OWNER, ["automations.read"]);
    await expectRefusal(await withToken(unrelated, "/sessions"), 403, "permission_required");
    await expectRefusal(
      await withToken(unrelated, `/sessions/${sessionName}/events`),
      403,
      "permission_required"
    );
  });

  it("is refused the session routes that do not accept tokens", async () => {
    const { sessionName } = await initSession({ userId: OWNER });
    const token = await issueToken(OWNER, [
      "sessions.read",
      "sessions.create",
      "sessions.sandbox_access",
      "sessions.lifecycle",
    ]);
    for (const [method, path] of [
      ["GET", `/sessions/${sessionName}/tunnel-urls`],
      ["GET", `/sessions/${sessionName}/sandbox-access`],
      ["POST", "/sessions"],
      ["POST", `/sessions/${sessionName}/archive`],
    ] as const) {
      await expectRefusal(
        await withToken(token, path, { method, body: method === "POST" ? {} : undefined }),
        403,
        "personal_access_token_not_accepted"
      );
    }
  });
});

describe("automations with a token", () => {
  it("reads automations and their runs with automations.read", async () => {
    await saveAutomation("auto-read", OWNER);
    const token = await issueToken(OWNER, ["automations.read"]);

    const list = await withToken(token, "/automations");
    expect(list.status).toBe(200);
    expect(JSON.stringify(await list.json())).toContain("auto-read");
    expect((await withToken(token, "/automations/auto-read")).status).toBe(200);
    expect((await withToken(token, "/automations/auto-read/invocations")).status).toBe(200);
  });

  it("creates an automation as its owner, attributed and audited to the token", async () => {
    const token = await issueToken(OWNER, ["automations.create", "sessions.create"]);
    const response = await withToken(token, "/automations", {
      method: "POST",
      body: {
        name: "Nightly triage",
        instructions: "Triage new issues",
        scheduleCron: "0 9 * * *",
        scheduleTz: "UTC",
      },
    });
    expect(response.status).toBe(201);
    const { automation } = await response.json<{ automation: { id: string } }>();
    expect(await new AutomationStore(env.DB).getById(automation.id)).toMatchObject({
      created_by: OWNER,
      user_id: OWNER,
    });

    const audit = await env.DB.prepare(
      `SELECT principal_kind, actor_user_id_snapshot, metadata_json FROM authorization_audit_events
        WHERE action = 'authorization.request_allowed' AND resource_id = '/automations'`
    ).first<{ principal_kind: string; actor_user_id_snapshot: string; metadata_json: string }>();
    expect(audit).toMatchObject({
      principal_kind: "personal-access-token",
      actor_user_id_snapshot: OWNER,
    });
    expect(JSON.parse(audit!.metadata_json)).toMatchObject({
      admission: "personal-access-token",
      personalAccessTokenId: expect.any(String),
    });
  });

  it("narrows target checks to the grant: the owner may use the environment, the token may not", async () => {
    await seedEnvironment("env_token_target", null);
    const body = {
      name: "Environment run",
      instructions: "Run tests",
      scheduleCron: "0 9 * * *",
      scheduleTz: "UTC",
      environmentIds: ["env_token_target"],
    };
    const withoutUse = await issueToken(OWNER, ["automations.create", "sessions.create"]);
    const refused = await withToken(withoutUse, "/automations", { method: "POST", body });
    expect(refused.status).toBe(403);
    await expect(refused.json()).resolves.toMatchObject({
      code: "permission_required",
      permission: "environments.use",
    });

    const withUse = await issueToken(OWNER, [
      "automations.create",
      "sessions.create",
      "environments.use",
    ]);
    expect((await withToken(withUse, "/automations", { method: "POST", body })).status).toBe(201);
  });

  it("triggers its owner's automation and launches the run as the owner, but no one else's", async () => {
    await saveAutomation("auto-own", OWNER);
    await saveAutomation("auto-other", OTHER);
    const token = await issueToken(OWNER, [
      "automations.read",
      "automations.trigger.own",
      "sessions.create",
    ]);

    const triggered = await withToken(token, "/automations/auto-own/trigger", { method: "POST" });
    expect(triggered.status).toBe(201);
    const [run] = await fetchRuns("auto-own");
    expect(run?.session_id).toEqual(expect.any(String));
    expect(await new SessionIndexStore(env.DB).get(run!.session_id!)).toMatchObject({
      userId: OWNER,
      spawnSource: "automation",
    });
    // The owner's authority ran it, but a token does not establish that a person fired it.
    expect(await invocationActorKinds("auto-own")).toEqual(["unknown"]);

    const foreign = await withToken(token, "/automations/auto-other/trigger", { method: "POST" });
    expect(foreign.status).toBe(403);
    expect(await fetchRuns("auto-other")).toEqual([]);
  });

  it.each([
    ["sessions.create", ["automations.trigger.own"], null],
    [
      "environments.use",
      ["automations.trigger.own", "sessions.create"],
      "env_token_trigger_target",
    ],
  ] as const)(
    "launches nothing when the token lacks %s, though its owner holds it",
    async (_withheld, grant, environmentId) => {
      await saveAutomation("auto-own", OWNER);
      if (environmentId) {
        await seedEnvironment(environmentId, null);
        await env.DB.prepare(
          "INSERT INTO automation_environments (automation_id, environment_id, created_at, updated_at) VALUES (?, ?, 1, 1)"
        )
          .bind("auto-own", environmentId)
          .run();
      }
      const token = await issueToken(OWNER, [...grant]);

      const refused = await withToken(token, "/automations/auto-own/trigger", { method: "POST" });
      expect(refused.status).toBe(403);
      await expect(refused.json()).resolves.toMatchObject({
        reason_code: "execution_authorization_denied",
      });
      expect(await fetchRuns("auto-own")).toEqual([]);
      expect(await invocationActorKinds("auto-own")).toEqual([]);
    }
  );

  it.each([
    ["PUT", "/automations/auto-own", { name: "Renamed" }],
    ["DELETE", "/automations/auto-own", undefined],
    ["POST", "/automations/auto-own/pause", undefined],
    ["POST", "/automations/auto-own/resume", undefined],
    ["POST", "/automations/auto-own/regenerate-key", undefined],
  ] as const)(
    "never rewrites, removes, or pauses an automation: %s %s",
    async (method, path, body) => {
      await saveAutomation("auto-own", OWNER);
      const token = await issueToken(OWNER, [
        "automations.read",
        "automations.manage.own",
        "automations.trigger.own",
      ]);
      await expectRefusal(
        await withToken(token, path, { method, body }),
        403,
        "personal_access_token_not_accepted"
      );
      expect(await new AutomationStore(env.DB).getById("auto-own")).toMatchObject({
        name: "auto-own",
        enabled: 1,
        deleted_at: null,
      });
    }
  );
});

describe("skills with a token", () => {
  it("reads the catalog with skills.read", async () => {
    const token = await issueToken(OWNER, ["skills.read"]);
    expect((await withToken(token, "/skills")).status).toBe(200);
  });

  it("reaches skill import only when granted skills.manage, and never bulk import or deletion", async () => {
    const reader = await issueToken(ADMIN, ["skills.read"]);
    await expectRefusal(
      await withToken(reader, "/skills/import/preview", { method: "POST", body: {} }),
      403,
      "permission_required"
    );

    const manager = await issueToken(ADMIN, ["skills.read", "skills.manage"]);
    // Admitted: the handler answers for the empty body rather than admission refusing it.
    expect(
      (await withToken(manager, "/skills/import/preview", { method: "POST", body: {} })).status
    ).toBe(400);
    await expectRefusal(
      await withToken(manager, "/skills/import/bulk", { method: "POST", body: {} }),
      403,
      "personal_access_token_not_accepted"
    );
    await expectRefusal(
      await withToken(manager, "/skills/skill-1", { method: "DELETE" }),
      403,
      "personal_access_token_not_accepted"
    );
  });

  it("never reads skill or repository content through import without skills.read", async () => {
    // Issued straight into storage: the route refuses this grant, but a grant can outlive a rule.
    const manager = await issueToken(ADMIN, ["skills.manage"]);
    for (const path of [
      "/skills/import/preview",
      "/skills/import",
      "/skills/skill-1/reimport/preview",
    ]) {
      await expectRefusal(
        await withToken(manager, path, { method: "POST", body: {} }),
        403,
        "permission_required"
      );
    }
  });

  it("loses skills.manage with its owner's role", async () => {
    const manager = await issueToken(ADMIN, ["skills.read", "skills.manage"]);
    await env.DB.prepare(
      "UPDATE user_role_assignments SET role_id = 'role_builtin_member' WHERE user_id = ?"
    )
      .bind(ADMIN)
      .run();
    await expectRefusal(
      await withToken(manager, "/skills/import/preview", { method: "POST", body: {} }),
      403,
      "permission_required"
    );
  });
});
