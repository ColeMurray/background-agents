import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutomationStore } from "../../src/db/automation-store";
import { EnvironmentStore } from "../../src/db/environments";
import { cleanD1Tables } from "./cleanup";
import { ownershipRequest, seedEnvironment } from "./ownership-test-helpers";

const ID = "auto-target-race";
const config = {
  conditions: [],
  repositoryFromPayload: { repoOwnerPath: "$.owner", repoNamePath: "$.name" },
};
function update(body: unknown) {
  return ownershipRequest(`/automations/${ID}`, { method: "PUT", body: JSON.stringify(body) });
}
function gate() {
  let entered!: () => void;
  let release!: () => void;
  return {
    entered: new Promise<void>((r) => {
      entered = r;
    }),
    released: new Promise<void>((r) => {
      release = r;
    }),
    enter: () => entered(),
    release: () => release(),
  };
}

describe("atomic automation target mutations", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    // Establish the real browser principal and role before creating its automation.
    const created = await ownershipRequest("/automations", {
      method: "POST",
      body: JSON.stringify({ name: "CI", instructions: "Investigate", triggerType: "webhook" }),
    });
    expect(created.status).toBe(201);
    const { automation } = (await created.json()) as { automation: { id: string } };
    await env.DB.prepare("UPDATE automations SET id = ? WHERE id = ?")
      .bind(ID, automation.id)
      .run();
    await seedEnvironment("env_race", null);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanD1Tables();
  });

  it("rejects payload enablement when a fixed target is committed after its validation read", async () => {
    const barrier = gate();
    const original = AutomationStore.prototype.getEnvironmentsForAutomation;
    let paused = false;
    vi.spyOn(AutomationStore.prototype, "getEnvironmentsForAutomation").mockImplementation(
      async function (this: AutomationStore, id) {
        const result = await original.call(this, id);
        if (id === ID && !paused) {
          paused = true;
          barrier.enter();
          await barrier.released;
        }
        return result;
      }
    );
    const payload = update({ triggerConfig: config });
    await barrier.entered;
    try {
      expect((await update({ environmentIds: ["env_race"] })).status).toBe(200);
    } finally {
      barrier.release();
    }
    const response = await payload;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "automation_conflict" });
    expect((await new AutomationStore(env.DB).getById(ID))?.trigger_config).toBeNull();
    expect(await new AutomationStore(env.DB).getEnvironmentsForAutomation(ID)).toHaveLength(1);
    expect((await update({ name: "Still editable" })).status).toBe(200);
  });

  it("rolls back a stale fixed-target edit after payload enablement commits", async () => {
    const barrier = gate();
    const original = EnvironmentStore.prototype.getById;
    vi.spyOn(EnvironmentStore.prototype, "getById").mockImplementation(async function (
      this: EnvironmentStore,
      id
    ) {
      const result = await original.call(this, id);
      if (id === "env_race") {
        barrier.enter();
        await barrier.released;
      }
      return result;
    });
    const fixed = update({ name: "Must roll back", environmentIds: ["env_race"] });
    await barrier.entered;
    try {
      expect((await update({ triggerConfig: config })).status).toBe(200);
    } finally {
      barrier.release();
    }
    expect((await fixed).status).toBe(409);
    expect((await env.DB.prepare("SELECT * FROM automation_target_guards").all()).results).toEqual(
      []
    );
    expect(await new AutomationStore(env.DB).getById(ID)).toMatchObject({
      name: "CI",
      trigger_config: JSON.stringify(config),
    });
    expect(await new AutomationStore(env.DB).getEnvironmentsForAutomation(ID)).toEqual([]);
  });
});
