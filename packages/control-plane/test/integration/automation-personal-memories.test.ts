import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AutomationStore, isPersonalMemoriesConsentConflict } from "../../src/db/automation-store";
import { SessionIndexStore } from "../../src/db/session-index";
import { resolvedPin } from "../../src/session/pinned";
import { cleanD1Tables } from "./cleanup";
import { seedActiveUser, serviceFetch, sqlDatabase } from "./helpers";
import { assignCustomRole as customRole, seedTeam } from "./ownership-test-helpers";

const EXECUTOR = "11111111111111111111111111111111";
const LEAD = "22222222222222222222222222222222";
const CANDIDATE = "33333333333333333333333333333333";
const TEAM = "team_personal_memories";
const AUTOMATION = "personal-memories";

function request(callerId: string, method: string, body: unknown, path = `/${AUTOMATION}`) {
  return serviceFetch(`https://cp.test/automations${path}`, {
    as: { userId: callerId, role: "member" },
    method,
    body: JSON.stringify(body),
  });
}

async function saveAutomation(includePersonalMemories = 0) {
  await env.DB.prepare(
    `INSERT INTO automations
       (id, owner_team_id, name, instructions, schedule_cron, model, created_by, user_id,
        include_personal_memories, created_at, updated_at)
     VALUES (?, ?, 'Personal memories', 'Run tests', '0 9 * * *', 'anthropic/claude-sonnet-4-6',
       ?, ?, ?, 1, 1)`
  )
    .bind(AUTOMATION, TEAM, EXECUTOR, EXECUTOR, includePersonalMemories)
    .run();
}

async function storedOptIn() {
  return (await new AutomationStore(env.DB).getById(AUTOMATION))?.include_personal_memories;
}

describe("automation personal-memory opt-in (integration)", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    for (const userId of [EXECUTOR, LEAD, CANDIDATE]) await seedActiveUser(userId);
    await seedTeam(TEAM, [
      [EXECUTOR, "member"],
      [LEAD, "lead"],
      [CANDIDATE, "member"],
    ]);
    await customRole(EXECUTOR, ["automations.create", "automations.manage.own", "sessions.create"]);
    await customRole(LEAD, ["automations.manage.own"]);
    await customRole(CANDIDATE, ["sessions.create"]);
  });
  afterEach(cleanD1Tables);

  it("records the creator's opt-in at creation and defaults to excluded", async () => {
    for (const includePersonalMemories of [true, undefined]) {
      const response = await request(
        EXECUTOR,
        "POST",
        {
          name: "Created",
          instructions: "Run tests",
          scheduleCron: "0 9 * * *",
          scheduleTz: "UTC",
          teamId: TEAM,
          includePersonalMemories,
        },
        ""
      );
      expect(response.status).toBe(201);
      await expect(response.json()).resolves.toMatchObject({
        automation: { userId: EXECUTOR, includePersonalMemories: includePersonalMemories === true },
      });
    }
  });

  it("lets the executor opt in", async () => {
    await saveAutomation();
    const response = await request(EXECUTOR, "PUT", { includePersonalMemories: true });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      automation: { includePersonalMemories: true },
    });
    expect(await storedOptIn()).toBe(1);
  });

  it("refuses a lead's opt-in on the executor's behalf without changing anything", async () => {
    await saveAutomation();
    const response = await request(LEAD, "PUT", {
      name: "Renamed",
      includePersonalMemories: true,
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "automation_personal_memories_executor_only",
    });
    const row = await new AutomationStore(env.DB).getById(AUTOMATION);
    expect(row).toMatchObject({ name: "Personal memories", include_personal_memories: 0 });
  });

  it("lets a lead resubmit the executor's opt-in unchanged or turn it off", async () => {
    await saveAutomation(1);
    const unchanged = await request(LEAD, "PUT", {
      name: "Renamed",
      includePersonalMemories: true,
    });
    expect(unchanged.status).toBe(200);
    expect(await storedOptIn()).toBe(1);

    const cleared = await request(LEAD, "PUT", { includePersonalMemories: false });
    expect(cleared.status).toBe(200);
    await expect(cleared.json()).resolves.toMatchObject({
      automation: { includePersonalMemories: false },
    });
    expect(await storedOptIn()).toBe(0);
  });

  it("clears the opt-in when the executor changes", async () => {
    await saveAutomation(1);
    const response = await request(LEAD, "PATCH", { userId: CANDIDATE });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      automation: { userId: CANDIDATE, includePersonalMemories: false },
    });
    expect(await storedOptIn()).toBe(0);
  });

  it("rolls back an edit whose opt-in no longer comes from the executor", async () => {
    // Admission saw the lead as executor; the executor changed before the edit's batch.
    await saveAutomation();
    const store = new AutomationStore(env.DB);
    const edit = (actorUserId: string) =>
      sqlDatabase(env.DB).batch([
        store.bindPersonalMemoriesUpdate(AUTOMATION, true, actorUserId),
        store.bindAutomationUpdate(AUTOMATION, { name: "Renamed" })!,
      ]);
    const conflict = await edit(LEAD).catch((error: unknown) => error);
    expect(isPersonalMemoriesConsentConflict(conflict)).toBe(true);
    expect(await store.getById(AUTOMATION)).toMatchObject({
      name: "Personal memories",
      include_personal_memories: 0,
    });

    await edit(EXECUTOR);
    expect(await store.getById(AUTOMATION)).toMatchObject({
      name: "Renamed",
      include_personal_memories: 1,
    });
  });

  describe("session memory pinning", () => {
    const SESSION = "automation-personal-memory-session";

    function createSession(personalOwnerUserId: string | null) {
      return new SessionIndexStore(env.DB).create({
        id: SESSION,
        title: null,
        userId: EXECUTOR,
        ownerTeamId: TEAM,
        visibility: "team",
        repoOwner: null,
        repoName: null,
        environmentId: null,
        model: "anthropic/claude-sonnet-4-6",
        reasoningEffort: null,
        baseBranch: null,
        status: "created",
        spawnSource: "automation",
        automationId: AUTOMATION,
        createdAt: 1,
        updatedAt: 1,
        memory: resolvedPin({
          selectionVersion: 1,
          manifestSha256: "manifest",
          resolvedAt: 1,
          personalOwnerUserId,
          directiveChars: 0,
          catalogChars: 0,
          estimatedTokens: 0,
          omittedCount: 0,
          items: [],
        }),
      });
    }

    async function pinnedOwner() {
      return env.DB.prepare(
        "SELECT personal_owner_user_id FROM session_memory_manifests WHERE session_id = ?"
      )
        .bind(SESSION)
        .first<{ personal_owner_user_id: string | null }>();
    }

    it("pins the executor's personal memories while their opt-in is live", async () => {
      await saveAutomation(1);
      await createSession(EXECUTOR);
      expect(await pinnedOwner()).toEqual({ personal_owner_user_id: EXECUTOR });
    });

    it.each([
      ["opted out", "UPDATE automations SET include_personal_memories = 0"],
      ["reassigned", `UPDATE automations SET user_id = '${CANDIDATE}'`],
      ["deleted", "UPDATE automations SET deleted_at = 2"],
    ])("does not create the session when the executor %s after selection", async (_change, sql) => {
      await saveAutomation(1);
      await env.DB.prepare(sql).run();
      await expect(createSession(EXECUTOR)).rejects.toThrow(/NOT NULL constraint failed/);
      expect(
        await env.DB.prepare("SELECT id FROM sessions WHERE id = ?").bind(SESSION).first()
      ).toBeNull();
    });

    it("pins without consent when personal memory is excluded", async () => {
      await saveAutomation(0);
      await createSession(null);
      expect(await pinnedOwner()).toEqual({ personal_owner_user_id: null });
    });
  });
});
