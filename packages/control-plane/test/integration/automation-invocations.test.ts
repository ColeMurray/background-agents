import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import {
  AutomationStore,
  deriveInvocationStatus,
  isDuplicateKeyError,
  type AutomationInvocationRow,
  type AutomationRow,
  type AutomationRunRow,
} from "../../src/db/automation-store";
import { isAutomationExecutionAuthorized } from "../../src/automation/authorization-guard";
import { cleanD1Tables } from "./cleanup";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeAutomation(overrides?: Partial<AutomationRow>): AutomationRow {
  const now = Date.now();
  return {
    id: `auto-${Math.random().toString(36).slice(2, 8)}`,
    name: "Test Automation",
    instructions: "Run tests",
    trigger_type: "schedule",
    schedule_cron: "0 9 * * *",
    schedule_tz: "UTC",
    model: "anthropic/claude-sonnet-4-6",
    reasoning_effort: null,
    enabled: 1,
    next_run_at: now + 86_400_000,
    consecutive_failures: 0,
    created_by: "user-1",
    user_id: "user-1",
    created_at: now,
    updated_at: now,
    deleted_at: null,
    event_type: null,
    trigger_config: null,
    trigger_auth_data: null,
    ...overrides,
  };
}

function makeInvocation(
  automationId: string,
  overrides?: Partial<AutomationInvocationRow>
): AutomationInvocationRow {
  const now = Date.now();
  return {
    id: `inv-${Math.random().toString(36).slice(2, 10)}`,
    automation_id: automationId,
    source: "manual",
    scheduled_at: null,
    trigger_key: null,
    concurrency_key: null,
    trigger_metadata: null,
    skip_reason: null,
    failure_counted_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function makeChild(automationId: string, overrides?: Partial<AutomationRunRow>): AutomationRunRow {
  const now = Date.now();
  return {
    id: `run-${Math.random().toString(36).slice(2, 10)}`,
    automation_id: automationId,
    invocation_id: `inv-child-${Math.random().toString(36).slice(2, 10)}`,
    session_id: null,
    status: "starting",
    skip_reason: null,
    failure_reason: null,
    scheduled_at: now,
    started_at: null,
    completed_at: null,
    created_at: now,
    repo_owner: null,
    repo_name: null,
    repo_id: null,
    base_branch: null,
    environment_id: null,
    ...overrides,
  };
}

async function countRows(table: string, where = "1=1"): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).first<{
    count: number;
  }>();
  return row?.count ?? 0;
}

describe("automation invocations (D1 integration)", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users
          (id, display_name, email, email_verified, avatar_url, created_at, updated_at)
         VALUES ('user-1', 'Execution Owner', NULL, 0, NULL, 1, 1)`
      ),
      env.DB.prepare(
        "UPDATE user_role_assignments SET role_id = 'role_builtin_owner' WHERE user_id = 'user-1'"
      ),
    ]);
  });

  it("checks owner and target-use permissions for unattended execution", async () => {
    const ownerId = "11111111111111111111111111111111";
    const roleId = "role_execution_test";
    const store = new AutomationStore(env.DB);
    const automation = makeAutomation({ user_id: ownerId, created_by: ownerId });

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users
          (id, display_name, email, email_verified, avatar_url, created_at, updated_at)
         VALUES (?, 'Execution Owner', NULL, 0, NULL, 1, 1)`
      ).bind(ownerId),
      env.DB.prepare(
        `INSERT INTO roles
          (id, key, name, normalized_name, description, is_system)
         VALUES (?, NULL, 'Execution Test', 'execution test', NULL, 0)`
      ).bind(roleId),
      env.DB.prepare("UPDATE user_role_assignments SET role_id = ? WHERE user_id = ?").bind(
        roleId,
        ownerId
      ),
    ]);
    await store.create(automation);
    await Promise.all(
      [
        ...store.bindRepositoryInserts(
          automation.id,
          [{ repo_owner: "acme", repo_name: "app", repo_id: 1, base_branch: "main" }],
          Date.now()
        ),
        ...store.bindEnvironmentInserts(automation.id, ["env_1"], Date.now()),
      ].map((statement) => statement.run())
    );

    const authorized = () =>
      isAutomationExecutionAuthorized(env.DB, {
        automationId: automation.id,
        requiresRepositoryUse: true,
        requiresEnvironmentUse: true,
      });
    const grant = (permission: string) =>
      env.DB.prepare("INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)")
        .bind(roleId, permission)
        .run();

    await expect(authorized()).resolves.toBe(false);
    await grant("sessions.create");
    await expect(authorized()).resolves.toBe(false);
    await grant("repositories.use");
    await expect(authorized()).resolves.toBe(false);
    await grant("environments.use");
    await expect(authorized()).resolves.toBe(true);
  });

  // ─── Derived status ────────────────────────────────────────────────────────

  describe("derived status", () => {
    async function seedInvocationWithChildren(
      childStatuses: Array<{ status: AutomationRunRow["status"]; completed_at?: number | null }>,
      invocationOverrides?: Partial<AutomationInvocationRow>
    ): Promise<{ store: AutomationStore; invocationId: string }> {
      const store = new AutomationStore(env.DB);
      const automationId = `auto-ds-${Math.random().toString(36).slice(2, 8)}`;
      await store.create(makeAutomation({ id: automationId }));
      const invocation = makeInvocation(automationId, invocationOverrides);
      const children = childStatuses.map((child, index) =>
        makeChild(automationId, {
          status: child.status,
          completed_at: child.completed_at ?? null,
          repo_owner: "acme",
          repo_name: `repo-${index}`,
        })
      );
      const { inserted } = await store.insertInvocationGuarded({
        invocation,
        children,
        overlapScope: { kind: "automation" },
      });
      expect(inserted).toBe(true);
      return { store, invocationId: invocation.id };
    }

    async function statusOf(store: AutomationStore, automationId: string, invocationId: string) {
      const { invocations } = await store.listInvocations(automationId, { limit: 50, offset: 0 });
      const invocation = invocations.find((inv) => inv.id === invocationId);
      expect(invocation).toBeDefined();
      return invocation!;
    }

    it("derives the full truth table and agrees with the TS twin", async () => {
      const cases: Array<{
        children: Array<{ status: AutomationRunRow["status"]; completed_at?: number }>;
        expected: string;
      }> = [
        { children: [{ status: "starting" }, { status: "starting" }], expected: "starting" },
        { children: [{ status: "starting" }, { status: "running" }], expected: "running" },
        {
          children: [{ status: "running" }, { status: "completed", completed_at: 5 }],
          expected: "running",
        },
        {
          children: [
            { status: "completed", completed_at: 5 },
            { status: "completed", completed_at: 9 },
          ],
          expected: "completed",
        },
        {
          children: [
            { status: "failed", completed_at: 5 },
            { status: "failed", completed_at: 6 },
          ],
          expected: "failed",
        },
        {
          children: [
            { status: "completed", completed_at: 5 },
            { status: "failed", completed_at: 7 },
          ],
          expected: "partial_failed",
        },
        // Legacy backfill shapes: skipped children exist only in old data.
        { children: [{ status: "skipped" }], expected: "skipped" },
        {
          children: [{ status: "failed", completed_at: 3 }, { status: "skipped" }],
          expected: "failed",
        },
      ];

      for (const testCase of cases) {
        const { store, invocationId } = await seedInvocationWithChildren(testCase.children);
        const invocation = await statusOf(
          store,
          (await store.getInvocationById(invocationId))!.automation_id,
          invocationId
        );
        expect(invocation.status).toBe(testCase.expected);

        // TS twin agreement (the SQL fragment and deriveInvocationStatus must
        // never diverge).
        const aggregate = await store.getInvocationRunAggregate(invocationId);
        const starting = testCase.children.filter((child) => child.status === "starting").length;
        expect(
          deriveInvocationStatus({
            total: aggregate.total,
            active: aggregate.active,
            failed: aggregate.failed,
            completed: aggregate.completed,
            skipped: aggregate.skipped,
            starting,
          })
        ).toBe(testCase.expected);
      }
    });

    it("derives skipped with settled completedAt for childless skip invocations", async () => {
      const store = new AutomationStore(env.DB);
      await store.create(makeAutomation({ id: "auto-skiprow" }));
      await store.insertSkippedInvocation(
        makeInvocation("auto-skiprow", {
          id: "inv-skip",
          source: "schedule",
          scheduled_at: 111,
          skip_reason: "concurrent_run_active",
          created_at: 500,
          updated_at: 500,
        })
      );

      const { invocations, total } = await store.listInvocations("auto-skiprow", {
        limit: 10,
        offset: 0,
      });
      expect(total).toBe(1);
      expect(invocations[0]).toMatchObject({
        id: "inv-skip",
        status: "skipped",
        skipReason: "concurrent_run_active",
        completedAt: 500,
        runs: [],
      });
    });

    it("derives completedAt as the latest child completion only when terminal", async () => {
      const { store, invocationId } = await seedInvocationWithChildren([
        { status: "completed", completed_at: 700 },
        { status: "completed", completed_at: 900 },
      ]);
      const automationId = (await store.getInvocationById(invocationId))!.automation_id;
      const terminal = await statusOf(store, automationId, invocationId);
      expect(terminal.completedAt).toBe(900);

      const active = await seedInvocationWithChildren([
        { status: "completed", completed_at: 100 },
        { status: "running" },
      ]);
      const activeAutomationId = (await active.store.getInvocationById(active.invocationId))!
        .automation_id;
      const running = await statusOf(active.store, activeAutomationId, active.invocationId);
      expect(running.completedAt).toBeNull();
    });
  });

  // ─── Guarded insert batch semantics (real D1 — meta.changes inside batch) ──

  describe("insertInvocationGuarded", () => {
    it("inserts invocation + children + advances the schedule in one batch", async () => {
      const store = new AutomationStore(env.DB);
      await store.create(makeAutomation({ id: "auto-g1", next_run_at: 1_000 }));

      const invocation = makeInvocation("auto-g1", {
        source: "schedule",
        scheduled_at: 1_000,
      });
      const { inserted } = await store.insertInvocationGuarded({
        invocation,
        children: [
          makeChild("auto-g1", { repo_owner: "acme", repo_name: "api" }),
          makeChild("auto-g1", { repo_owner: "acme", repo_name: "web" }),
        ],
        overlapScope: { kind: "automation" },
        advanceSchedule: { fromSlot: 1_000, nextRunAt: 2_000 },
      });

      expect(inserted).toBe(true);
      expect(await countRows("automation_runs", `invocation_id = '${invocation.id}'`)).toBe(2);
      const automation = await store.getById("auto-g1");
      expect(automation!.next_run_at).toBe(2_000);
    });

    it("suppresses the invocation and children when an active run exists, but still advances", async () => {
      const store = new AutomationStore(env.DB);
      await store.create(makeAutomation({ id: "auto-g2", next_run_at: 1_000 }));

      const first = makeInvocation("auto-g2", { source: "schedule", scheduled_at: 1_000 });
      await store.insertInvocationGuarded({
        invocation: first,
        children: [
          makeChild("auto-g2", { status: "running", repo_owner: "acme", repo_name: "api" }),
        ],
        overlapScope: { kind: "automation" },
      });

      const second = makeInvocation("auto-g2", { source: "schedule", scheduled_at: 1_500 });
      const result = await store.insertInvocationGuarded({
        invocation: second,
        children: [
          makeChild("auto-g2", { repo_owner: "acme", repo_name: "api" }),
          makeChild("auto-g2", { repo_owner: "acme", repo_name: "web" }),
        ],
        overlapScope: { kind: "automation" },
        // This firing observed slot 1_000, so it is the one entitled to move it.
        advanceSchedule: { fromSlot: 1_000, nextRunAt: 3_000 },
      });

      // The 0-row guarded INSERT is a success, not an error: D1 batch() does
      // NOT roll back, children are 0-row no-ops, and the advance still
      // applies because this firing still owns the slot. This is the real-D1
      // verification of the meta.changes-per-statement semantics the scheduler
      // depends on.
      expect(result.inserted).toBe(false);
      expect(await store.getInvocationById(second.id)).toBeNull();
      expect(await countRows("automation_runs", `invocation_id = '${second.id}'`)).toBe(0);
      expect((await store.getById("auto-g2"))!.next_run_at).toBe(3_000);
    });

    it("scopes event overlap per concurrency key — PR #42 active does not block PR #43", async () => {
      const store = new AutomationStore(env.DB);
      await store.create(makeAutomation({ id: "auto-g3", trigger_type: "github_event" }));

      const pr42 = makeInvocation("auto-g3", {
        source: "event",
        trigger_key: "pr:42:opened",
        concurrency_key: "pr:42",
      });
      await store.insertInvocationGuarded({
        invocation: pr42,
        children: [
          makeChild("auto-g3", { status: "running", repo_owner: "acme", repo_name: "api" }),
        ],
        overlapScope: { kind: "concurrencyKey", concurrencyKey: "pr:42" },
      });

      const pr43 = makeInvocation("auto-g3", {
        source: "event",
        trigger_key: "pr:43:opened",
        concurrency_key: "pr:43",
      });
      const other = await store.insertInvocationGuarded({
        invocation: pr43,
        children: [makeChild("auto-g3", { repo_owner: "acme", repo_name: "api" })],
        overlapScope: { kind: "concurrencyKey", concurrencyKey: "pr:43" },
      });
      expect(other.inserted).toBe(true);

      const pr42Again = makeInvocation("auto-g3", {
        source: "event",
        trigger_key: "pr:42:synchronize",
        concurrency_key: "pr:42",
      });
      const blocked = await store.insertInvocationGuarded({
        invocation: pr42Again,
        children: [makeChild("auto-g3", { repo_owner: "acme", repo_name: "api" })],
        overlapScope: { kind: "concurrencyKey", concurrencyKey: "pr:42" },
      });
      expect(blocked.inserted).toBe(false);
    });

    it("rolls back the whole batch (including the advance) on a cron double-fire", async () => {
      const store = new AutomationStore(env.DB);
      await store.create(makeAutomation({ id: "auto-g4", next_run_at: 1_000 }));

      const slotA = makeInvocation("auto-g4", { source: "schedule", scheduled_at: 1_000 });
      await store.insertInvocationGuarded({
        invocation: slotA,
        children: [
          makeChild("auto-g4", {
            status: "completed",
            completed_at: 1_100,
            repo_owner: "acme",
            repo_name: "api",
          }),
        ],
        overlapScope: { kind: "automation" },
        advanceSchedule: { fromSlot: 1_000, nextRunAt: 2_000 },
      });

      const duplicateSlot = makeInvocation("auto-g4", { source: "schedule", scheduled_at: 1_000 });
      let caught: unknown = null;
      try {
        await store.insertInvocationGuarded({
          invocation: duplicateSlot,
          children: [makeChild("auto-g4", { repo_owner: "acme", repo_name: "api" })],
          overlapScope: { kind: "automation" },
          advanceSchedule: { fromSlot: 1_000, nextRunAt: 9_999 },
        });
      } catch (e) {
        caught = e;
      }

      expect(caught).not.toBeNull();
      expect(isDuplicateKeyError(caught)).toBe(true);
      expect(await store.getInvocationById(duplicateSlot.id)).toBeNull();
      // The advance in the failed batch rolled back with it.
      expect((await store.getById("auto-g4"))!.next_run_at).toBe(2_000);
    });

    it("rejects event dedup duplicates atomically via the trigger-key index", async () => {
      const store = new AutomationStore(env.DB);
      await store.create(makeAutomation({ id: "auto-g5", trigger_type: "github_event" }));

      const first = makeInvocation("auto-g5", {
        source: "event",
        trigger_key: "issue:7",
        concurrency_key: "issue:7",
      });
      await store.insertInvocationGuarded({
        invocation: first,
        children: [
          makeChild("auto-g5", {
            status: "completed",
            completed_at: 10,
            repo_owner: "acme",
            repo_name: "api",
          }),
        ],
        overlapScope: { kind: "concurrencyKey", concurrencyKey: "issue:7" },
      });

      const duplicate = makeInvocation("auto-g5", {
        source: "event",
        trigger_key: "issue:7",
        concurrency_key: "issue:7",
      });
      let caught: unknown = null;
      try {
        await store.insertInvocationGuarded({
          invocation: duplicate,
          children: [makeChild("auto-g5", { repo_owner: "acme", repo_name: "api" })],
          overlapScope: { kind: "concurrencyKey", concurrencyKey: "issue:7" },
        });
      } catch (e) {
        caught = e;
      }
      expect(isDuplicateKeyError(caught)).toBe(true);
      expect(await countRows("automation_invocations", "trigger_key = 'issue:7'")).toBe(1);
    });

    it("enforces one run per repository per invocation", async () => {
      const store = new AutomationStore(env.DB);
      await store.create(makeAutomation({ id: "auto-g6" }));

      let caught: unknown = null;
      try {
        await store.insertInvocationGuarded({
          invocation: makeInvocation("auto-g6"),
          children: [
            makeChild("auto-g6", { repo_owner: "acme", repo_name: "api" }),
            makeChild("auto-g6", { repo_owner: "acme", repo_name: "api" }),
          ],
          overlapScope: { kind: "automation" },
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).not.toBeNull();
      expect(String(caught)).toContain("UNIQUE constraint failed");
    });
  });

  // ─── Atomic skip + advance ─────────────────────────────────────────────────

  describe("insertSkippedInvocation", () => {
    it("records a childless skip and advances the schedule atomically", async () => {
      const store = new AutomationStore(env.DB);
      await store.create(makeAutomation({ id: "auto-s1", next_run_at: 1_000 }));

      const { inserted } = await store.insertSkippedInvocation(
        makeInvocation("auto-s1", {
          source: "schedule",
          scheduled_at: 1_000,
          skip_reason: "concurrent_run_active",
        }),
        { fromSlot: 1_000, nextRunAt: 2_000 }
      );

      expect(inserted).toBe(true);
      expect((await store.getById("auto-s1"))!.next_run_at).toBe(2_000);
      expect(await countRows("automation_invocations", "skip_reason IS NOT NULL")).toBe(1);
    });

    it("hands the slot over exactly once when two skips collide (INSERT OR IGNORE)", async () => {
      const store = new AutomationStore(env.DB);
      await store.create(makeAutomation({ id: "auto-s2", next_run_at: 1_000 }));

      await store.insertSkippedInvocation(
        makeInvocation("auto-s2", {
          source: "schedule",
          scheduled_at: 1_000,
          skip_reason: "concurrent_run_active",
        }),
        { fromSlot: 1_000, nextRunAt: 2_000 }
      );
      const second = await store.insertSkippedInvocation(
        makeInvocation("auto-s2", {
          source: "schedule",
          scheduled_at: 1_000,
          skip_reason: "concurrent_run_active",
        }),
        { fromSlot: 1_000, nextRunAt: 3_000 }
      );

      // The duplicate skip is ignored AND its advance is a no-op: it claimed
      // slot 1_000, which the first skip already handed to 2_000. Letting it
      // advance anyway would move 2_000 -> 3_000 and slot 2_000 would never
      // fire. The re-collision this guards against is already impossible —
      // the winning skip moved next_run_at off 1_000.
      expect(second.inserted).toBe(false);
      expect((await store.getById("auto-s2"))!.next_run_at).toBe(2_000);
    });
  });

  // ─── Finalization primitives ───────────────────────────────────────────────

  describe("finalization", () => {
    it("failure-counted CAS admits exactly one winner", async () => {
      const store = new AutomationStore(env.DB);
      await store.create(makeAutomation({ id: "auto-cas" }));
      const invocation = makeInvocation("auto-cas");
      await store.insertInvocationGuarded({
        invocation,
        children: [
          makeChild("auto-cas", {
            status: "failed",
            completed_at: 100,
            repo_owner: "acme",
            repo_name: "api",
          }),
        ],
        overlapScope: { kind: "automation" },
      });

      expect(await store.tryMarkInvocationFailureCounted(invocation.id)).toBe(true);
      expect(await store.tryMarkInvocationFailureCounted(invocation.id)).toBe(false);
    });

    it("updateRun refuses to resurrect a terminal run", async () => {
      const store = new AutomationStore(env.DB);
      await store.create(makeAutomation({ id: "auto-guard" }));
      const invocation = makeInvocation("auto-guard");
      const child = makeChild("auto-guard", {
        status: "completed",
        completed_at: 500,
        repo_owner: "acme",
        repo_name: "api",
      });
      await store.insertInvocationGuarded({
        invocation,
        children: [child],
        overlapScope: { kind: "automation" },
      });

      const changed = await store.updateRun(child.id, { status: "failed", completed_at: 900 });
      expect(changed).toBe(false);

      const row = await env.DB.prepare(`SELECT status FROM automation_runs WHERE id = ?`)
        .bind(child.id)
        .first<{ status: string }>();
      expect(row!.status).toBe("completed");
    });

    it("bulkFailRunningRuns only fails running rows", async () => {
      const store = new AutomationStore(env.DB);
      await store.create(makeAutomation({ id: "auto-bulkfail" }));
      const invocation = makeInvocation("auto-bulkfail");
      const done = makeChild("auto-bulkfail", {
        status: "completed",
        completed_at: 100,
        repo_owner: "acme",
        repo_name: "api",
      });
      const stuck = makeChild("auto-bulkfail", {
        status: "running",
        repo_owner: "acme",
        repo_name: "web",
      });
      await store.insertInvocationGuarded({
        invocation,
        children: [done, stuck],
        overlapScope: { kind: "automation" },
      });

      await store.bulkFailRunningRuns([done.id, stuck.id], "timeout", 999);

      const statuses = await env.DB.prepare(
        `SELECT id, status FROM automation_runs WHERE invocation_id = ?`
      )
        .bind(invocation.id)
        .all<{ id: string; status: string }>();
      const byId = new Map(statuses.results!.map((row) => [row.id, row.status]));
      expect(byId.get(done.id)).toBe("completed");
      expect(byId.get(stuck.id)).toBe("failed");
    });

    it("does not fail a run claimed after the orphan sweep reads it", async () => {
      const store = new AutomationStore(env.DB);
      await store.create(makeAutomation({ id: "auto-claim-race" }));
      const invocation = makeInvocation("auto-claim-race");
      const child = makeChild("auto-claim-race", {
        status: "starting",
        created_at: 1,
        repo_owner: "acme",
        repo_name: "web",
      });
      await store.insertInvocationGuarded({
        invocation,
        children: [child],
        overlapScope: { kind: "automation" },
      });

      const [staleOrphan] = await store.getOrphanedStartingRuns(0, 10);
      expect(staleOrphan?.id).toBe(child.id);
      await expect(store.claimRunSession(child.id, "session-1", 500)).resolves.toBe(true);
      await store.bulkFailStartingRuns([staleOrphan!.id], "session_creation_timeout", 999);

      const row = await env.DB.prepare(
        `SELECT status, session_id FROM automation_runs WHERE id = ?`
      )
        .bind(child.id)
        .first<{ status: string; session_id: string | null }>();
      expect(row).toEqual({ status: "running", session_id: "session-1" });
    });

    it("getUncountedFailedInvocations finds exactly the crash-window invocations", async () => {
      const store = new AutomationStore(env.DB);
      await store.create(makeAutomation({ id: "auto-sweep" }));

      // (1) all-terminal with a failed child, uncounted → matched.
      const missed = makeInvocation("auto-sweep", { id: "inv-missed" });
      await store.insertInvocationGuarded({
        invocation: missed,
        children: [
          makeChild("auto-sweep", {
            status: "failed",
            completed_at: 100,
            repo_owner: "acme",
            repo_name: "api",
          }),
        ],
        overlapScope: { kind: "automation" },
      });

      // (2) failed but already counted → not matched.
      const counted = makeInvocation("auto-sweep", { id: "inv-counted" });
      await store.insertInvocationGuarded({
        invocation: counted,
        children: [
          makeChild("auto-sweep", {
            status: "failed",
            completed_at: 100,
            repo_owner: "acme",
            repo_name: "web",
          }),
        ],
        overlapScope: { kind: "automation" },
      });
      await store.tryMarkInvocationFailureCounted("inv-counted");

      // (3) still active → not matched.
      // (Overlap guard: use per-key scope so seeding succeeds despite actives.)
      const active = makeInvocation("auto-sweep", {
        id: "inv-active",
        source: "event",
        trigger_key: "k1",
        concurrency_key: "k1",
      });
      await store.insertInvocationGuarded({
        invocation: active,
        children: [
          makeChild("auto-sweep", {
            status: "running",
            repo_owner: "acme",
            repo_name: "docs",
          }),
          makeChild("auto-sweep", {
            status: "failed",
            completed_at: 50,
            repo_owner: "acme",
            repo_name: "infra",
          }),
        ],
        overlapScope: { kind: "concurrencyKey", concurrencyKey: "k1" },
      });

      const uncounted = await store.getUncountedFailedInvocations(0, 10);
      expect(uncounted.map((invocation) => invocation.id)).toEqual(["inv-missed"]);
    });

    it("getStaleFailureResetCandidates surfaces the latest invocation of failing automations", async () => {
      const store = new AutomationStore(env.DB);
      await store.create(makeAutomation({ id: "auto-reset", consecutive_failures: 2 }));
      await store.create(makeAutomation({ id: "auto-healthy", consecutive_failures: 0 }));

      const older = makeInvocation("auto-reset", {
        id: "inv-old",
        created_at: 1_000,
        updated_at: 1_000,
      });
      await store.insertInvocationGuarded({
        invocation: older,
        children: [
          makeChild("auto-reset", {
            status: "failed",
            completed_at: 1_100,
            repo_owner: "acme",
            repo_name: "api",
          }),
        ],
        overlapScope: { kind: "automation" },
      });
      const latest = makeInvocation("auto-reset", {
        id: "inv-latest",
        created_at: 2_000,
        updated_at: 2_000,
      });
      await store.insertInvocationGuarded({
        invocation: latest,
        children: [
          makeChild("auto-reset", {
            status: "completed",
            completed_at: 2_100,
            repo_owner: "acme",
            repo_name: "api",
          }),
        ],
        overlapScope: { kind: "automation" },
      });

      const candidates = await store.getStaleFailureResetCandidates(0, 10);
      expect(candidates).toEqual([{ automation_id: "auto-reset", invocation_id: "inv-latest" }]);
    });
  });

  // ─── Scalar mirror ────────────────────────────────────────────────────────

  // ─── Invocations listing over mixed history ───────────────────────────────

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
