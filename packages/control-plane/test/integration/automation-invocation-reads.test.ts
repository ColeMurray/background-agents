import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { AutomationStore } from "../../src/db/automation-store";
import { cleanD1Tables } from "./cleanup";
import { makeAutomation, makeChild, makeInvocation } from "./invocation-fixtures";

describe("automation invocation reads (D1 integration)", () => {
  beforeEach(async () => {
    await cleanD1Tables();
  });

  describe("invocations listing over mixed history", () => {
    /**
     * One automation with all three history shapes at once:
     *  - an invocation of 1 (single completed child)   (t=1000)
     *  - a childless skipped invocation                (t=2000)
     *  - a multi-repo invocation with two children     (t=3000)
     */
    async function seedMixedHistory(automationId: string): Promise<AutomationStore> {
      const store = new AutomationStore(env.DB);
      await store.create(makeAutomation({ id: automationId }));

      await store.insertInvocationGuarded({
        invocation: makeInvocation(automationId, {
          id: "inv-single",
          source: "schedule",
          scheduled_at: 1_000,
          created_at: 1_000,
          updated_at: 1_000,
        }),
        children: [
          makeChild(automationId, {
            id: "run-legacy",
            status: "completed",
            scheduled_at: 1_000,
            completed_at: 1_500,
            created_at: 1_000,
            repo_owner: "acme",
            repo_name: "web-app",
            repo_id: 1,
            base_branch: "main",
          }),
        ],
        overlapScope: { kind: "automation" },
      });

      await store.insertSkippedInvocation(
        makeInvocation(automationId, {
          id: "inv-skip",
          source: "schedule",
          scheduled_at: 2_000,
          skip_reason: "concurrent_run_active",
          created_at: 2_000,
          updated_at: 2_000,
        })
      );

      await store.insertInvocationGuarded({
        invocation: makeInvocation(automationId, {
          id: "inv-multi",
          source: "schedule",
          scheduled_at: 3_000,
          concurrency_key: "firing-key",
          created_at: 3_000,
          updated_at: 3_000,
        }),
        children: [
          makeChild(automationId, {
            id: "run-web",
            status: "completed",
            scheduled_at: 3_000,
            completed_at: 3_500,
            created_at: 3_000,
            repo_owner: "acme",
            repo_name: "web-app",
            repo_id: 1,
            base_branch: "main",
          }),
          makeChild(automationId, {
            id: "run-api",
            status: "completed",
            scheduled_at: 3_000,
            completed_at: 3_600,
            created_at: 3_001,
            repo_owner: "acme",
            repo_name: "api",
            repo_id: 2,
            base_branch: "develop",
          }),
        ],
        overlapScope: { kind: "automation" },
      });

      return store;
    }

    it("lists invocations over mixed history — one entry per firing", async () => {
      const store = await seedMixedHistory("auto-list-inv");

      const { invocations, total } = await store.listInvocations("auto-list-inv", {
        limit: 50,
        offset: 0,
      });

      expect(total).toBe(3);
      expect(invocations.map((invocation) => invocation.id)).toEqual([
        "inv-multi",
        "inv-skip",
        "inv-single",
      ]);

      const multi = invocations[0];
      expect(multi.status).toBe("completed");
      expect(multi.runs.map((run) => run.repoName)).toEqual(["web-app", "api"]);

      const skip = invocations[1];
      expect(skip.status).toBe("skipped");
      expect(skip.skipReason).toBe("concurrent_run_active");
      expect(skip.runs).toEqual([]);

      const single = invocations[2];
      expect(single.status).toBe("completed");
      expect(single.runs.map((run) => run.id)).toEqual(["run-legacy"]);
    });

    it("reads one invocation exactly as the listing shows it, scoped to its automation", async () => {
      const store = await seedMixedHistory("auto-get-inv");
      const { invocations } = await store.listInvocations("auto-get-inv", { limit: 50, offset: 0 });

      for (const listed of invocations) {
        expect(await store.getInvocation("auto-get-inv", listed.id)).toEqual(listed);
      }
      expect(await store.getInvocation("auto-other", "inv-multi")).toBeNull();
      expect(await store.getInvocation("auto-get-inv", "inv-missing")).toBeNull();
    });

    it("finds the invocation that owns an event trigger key, never a skip", async () => {
      const store = await seedMixedHistory("auto-trigger-key");
      await store.insertInvocationGuarded({
        invocation: makeInvocation("auto-trigger-key", {
          id: "inv-event",
          source: "event",
          trigger_key: "webhook:idem:abc",
        }),
        children: [makeChild("auto-trigger-key")],
        overlapScope: { kind: "automation" },
      });

      expect(await store.getInvocationIdByTriggerKey("auto-trigger-key", "webhook:idem:abc")).toBe(
        "inv-event"
      );
      expect(await store.getInvocationIdByTriggerKey("auto-other", "webhook:idem:abc")).toBeNull();
      expect(
        await store.getInvocationIdByTriggerKey("auto-trigger-key", "webhook:idem:other")
      ).toBeNull();
    });

    it("batches bounded recent execution summaries across automations", async () => {
      const store = await seedMixedHistory("auto-recent-a");
      await store.create(makeAutomation({ id: "auto-recent-b" }));
      await store.insertInvocationGuarded({
        invocation: makeInvocation("auto-recent-b", {
          id: "inv-failed",
          created_at: 4_000,
          updated_at: 4_000,
        }),
        children: [
          makeChild("auto-recent-b", {
            status: "failed",
            completed_at: 4_500,
            created_at: 4_000,
          }),
        ],
        overlapScope: { kind: "automation" },
      });

      const summaries = await store.listRecentExecutionsForAutomationIds(
        ["auto-recent-a", "auto-recent-b", "auto-empty"],
        2
      );

      expect(summaries.get("auto-recent-a")).toEqual([
        { id: "inv-multi", status: "completed", createdAt: 3_000 },
        { id: "inv-skip", status: "skipped", createdAt: 2_000 },
      ]);
      expect(summaries.get("auto-recent-b")).toEqual([
        { id: "inv-failed", status: "failed", createdAt: 4_000 },
      ]);
      expect(summaries.get("auto-empty")).toEqual([]);
    });
  });
});
