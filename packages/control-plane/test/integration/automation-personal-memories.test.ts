import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AutomationStore } from "../../src/db/automation-store";
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

  it("applies an opt-in write only while the actor is still the executor", async () => {
    await saveAutomation();
    const store = new AutomationStore(env.DB);
    const [lead] = await sqlDatabase(env.DB).batch([
      store.bindPersonalMemoriesUpdate(AUTOMATION, true, LEAD),
    ]);
    expect(lead.meta.changes).toBe(0);
    const [executor] = await sqlDatabase(env.DB).batch([
      store.bindPersonalMemoriesUpdate(AUTOMATION, true, EXECUTOR),
    ]);
    expect(executor.meta.changes).toBe(1);
    expect(await storedOptIn()).toBe(1);
  });
});
