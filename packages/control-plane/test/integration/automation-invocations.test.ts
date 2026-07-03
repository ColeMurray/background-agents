import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import {
  AutomationStore,
  deriveInvocationStatus,
  isDuplicateKeyError,
  repositoryScalarMirror,
  type AutomationInvocationRow,
  type AutomationRow,
  type AutomationRunRow,
} from "../../src/db/automation-store";
import { cleanD1Tables } from "./cleanup";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeAutomation(overrides?: Partial<AutomationRow>): AutomationRow {
  const now = Date.now();
  return {
    id: `auto-${Math.random().toString(36).slice(2, 8)}`,
    name: "Test Automation",
    repo_owner: "acme",
    repo_name: "web-app",
    base_branch: "main",
    repo_id: 12345,
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
    user_id: null,
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
    invocation_id: null,
    session_id: null,
    status: "starting",
    skip_reason: null,
    failure_reason: null,
    scheduled_at: now,
    started_at: null,
    completed_at: null,
    created_at: now,
    trigger_key: null,
    concurrency_key: null,
    repo_owner: null,
    repo_name: null,
    repo_id: null,
    base_branch: null,
    ...overrides,
  };
}

/** Insert a LEGACY-shaped run via raw SQL: only pre-0030 columns, so the new
 *  columns take their NULL defaults exactly as rows written by old code do. */
async function seedLegacyRun(run: {
  id: string;
  automation_id: string;
  session_id?: string | null;
  status: string;
  skip_reason?: string | null;
  failure_reason?: string | null;
  scheduled_at: number;
  started_at?: number | null;
  completed_at?: number | null;
  created_at: number;
  trigger_key?: string | null;
  concurrency_key?: string | null;
  trigger_run_metadata?: string | null;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO automation_runs
     (id, automation_id, session_id, status, skip_reason, failure_reason,
      scheduled_at, started_at, completed_at, created_at, trigger_key,
      concurrency_key, trigger_run_metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      run.id,
      run.automation_id,
      run.session_id ?? null,
      run.status,
      run.skip_reason ?? null,
      run.failure_reason ?? null,
      run.scheduled_at,
      run.started_at ?? null,
      run.completed_at ?? null,
      run.created_at,
      run.trigger_key ?? null,
      run.concurrency_key ?? null,
      run.trigger_run_metadata ?? null
    )
    .run();
}

async function seedSession(session: {
  id: string;
  repo_owner?: string | null;
  repo_name?: string | null;
  base_branch?: string | null;
}): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO sessions (id, repo_owner, repo_name, base_branch, model, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'anthropic/claude-sonnet-4-6', 'completed', ?, ?)`
  )
    .bind(
      session.id,
      session.repo_owner ?? null,
      session.repo_name ?? null,
      session.base_branch ?? null,
      now,
      now
    )
    .run();
}

/**
 * Re-execute migration 0030's backfill statements (the INSERT/UPDATE half of
 * the file — DDL excluded) against the live database. This runs the REAL
 * migration SQL over legacy-shaped seed rows, and doubles as the test that the
 * statements are idempotent (they are the documented roll-forward repair
 * script).
 */
async function replayBackfill(): Promise<void> {
  const migration = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0030"));
  expect(migration).toBeDefined();
  const statements = migration!.queries.filter((query) => {
    const body = query.replace(/^\s*--.*$/gm, "").trim();
    return /^(INSERT INTO automation_(repositories|invocations)|UPDATE automation_runs)/i.test(
      body
    );
  });
  // repositories backfill, invocations backfill, invocation_id link, snapshot.
  expect(statements).toHaveLength(4);
  for (const sql of statements) {
    await env.DB.prepare(sql).run();
  }
}

async function countRows(table: string, where = "1=1"): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).first<{
    count: number;
  }>();
  return row?.count ?? 0;
}

describe("automation invocations (D1 integration)", () => {
  beforeEach(cleanD1Tables);

  // ─── 0030 backfill ─────────────────────────────────────────────────────────

  describe("0030 backfill replay", () => {
    it("creates invocations of 1 for legacy runs with keys and skip data hoisted", async () => {
      const store = new AutomationStore(env.DB);
      await store.create(makeAutomation({ id: "auto-bf" }));

      await seedLegacyRun({
        id: "run-sched",
        automation_id: "auto-bf",
        status: "completed",
        scheduled_at: 1_000,
        completed_at: 1_500,
        created_at: 1_000,
      });
      await seedLegacyRun({
        id: "run-event",
        automation_id: "auto-bf",
        status: "completed",
        scheduled_at: 2_000,
        completed_at: 2_500,
        created_at: 2_000,
        trigger_key: "pr:42",
        concurrency_key: "pr:42",
        trigger_run_metadata: JSON.stringify({ channel: "C1" }),
      });
      await seedLegacyRun({
        id: "run-skip",
        automation_id: "auto-bf",
        status: "skipped",
        skip_reason: "concurrent_run_active",
        scheduled_at: 3_000,
        completed_at: 3_000,
        created_at: 3_000,
      });

      await replayBackfill();

      const scheduled = await store.getInvocationById("run-sched");
      expect(scheduled).toMatchObject({
        automation_id: "auto-bf",
        source: "schedule",
        scheduled_at: 1_000,
        trigger_key: null,
        skip_reason: null,
        failure_counted_at: null,
      });

      const event = await store.getInvocationById("run-event");
      expect(event).toMatchObject({
        source: "event",
        scheduled_at: null,
        trigger_key: "pr:42",
        concurrency_key: "pr:42",
        trigger_metadata: JSON.stringify({ channel: "C1" }),
      });

      const skip = await store.getInvocationById("run-skip");
      expect(skip).toMatchObject({ source: "schedule", skip_reason: "concurrent_run_active" });

      expect(await countRows("automation_runs", "invocation_id IS NULL")).toBe(0);
      expect(await countRows("automation_runs", "invocation_id = id")).toBe(3);
    });

    it("stamps failure_counted_at on failed legacy runs so the sweep never re-counts them", async () => {
      const store = new AutomationStore(env.DB);
      await store.create(makeAutomation({ id: "auto-bf2" }));
      await seedLegacyRun({
        id: "run-failed",
        automation_id: "auto-bf2",
        status: "failed",
        scheduled_at: 1_000,
        completed_at: 1_800,
        created_at: 1_000,
      });

      await replayBackfill();

      const invocation = await store.getInvocationById("run-failed");
      expect(invocation!.failure_counted_at).toBe(1_800);

      const uncounted = await store.getUncountedFailedInvocations(0, 10);
      expect(uncounted).toHaveLength(0);
    });

    it("snapshots run repositories from their sessions, not the automation row", async () => {
      const store = new AutomationStore(env.DB);
      // Automation has since been retargeted to a different repository.
      await store.create(
        makeAutomation({ id: "auto-retarget", repo_owner: "acme", repo_name: "new-repo" })
      );
      await seedSession({
        id: "sess-old",
        repo_owner: "acme",
        repo_name: "old-repo",
        base_branch: "develop",
      });
      await seedLegacyRun({
        id: "run-old",
        automation_id: "auto-retarget",
        session_id: "sess-old",
        status: "completed",
        scheduled_at: 1_000,
        completed_at: 1_500,
        created_at: 1_000,
      });
      // Session-less run keeps a NULL snapshot.
      await seedLegacyRun({
        id: "run-no-session",
        automation_id: "auto-retarget",
        status: "failed",
        scheduled_at: 2_000,
        completed_at: 2_100,
        created_at: 2_000,
      });

      await replayBackfill();

      const withSession = await env.DB.prepare(
        `SELECT repo_owner, repo_name, base_branch, repo_id FROM automation_runs WHERE id = 'run-old'`
      ).first<{ repo_owner: string; repo_name: string; base_branch: string; repo_id: number }>();
      expect(withSession).toMatchObject({
        repo_owner: "acme",
        repo_name: "old-repo",
        base_branch: "develop",
        repo_id: null,
      });

      const withoutSession = await env.DB.prepare(
        `SELECT repo_owner, repo_name FROM automation_runs WHERE id = 'run-no-session'`
      ).first<{ repo_owner: string | null; repo_name: string | null }>();
      expect(withoutSession).toMatchObject({ repo_owner: null, repo_name: null });
    });

    it("scrubs blank legacy session repo values instead of copying half pairs", async () => {
      const store = new AutomationStore(env.DB);
      await store.create(makeAutomation({ id: "auto-blank" }));
      await seedSession({
        id: "sess-blank",
        repo_owner: "  ",
        repo_name: "Repo-X",
        base_branch: "main",
      });
      await seedLegacyRun({
        id: "run-blank",
        automation_id: "auto-blank",
        session_id: "sess-blank",
        status: "completed",
        scheduled_at: 1_000,
        completed_at: 1_100,
        created_at: 1_000,
      });

      await replayBackfill();

      const run = await env.DB.prepare(
        `SELECT repo_owner, repo_name, base_branch FROM automation_runs WHERE id = 'run-blank'`
      ).first<{
        repo_owner: string | null;
        repo_name: string | null;
        base_branch: string | null;
      }>();
      expect(run).toMatchObject({ repo_owner: null, repo_name: null, base_branch: null });
    });

    it("backfills repository rows from automation scalars with trim/lowercase normalization", async () => {
      const store = new AutomationStore(env.DB);
      await env.DB.prepare(
        `INSERT INTO automations (id, name, repo_owner, repo_name, base_branch, repo_id, instructions,
          trigger_type, schedule_tz, model, enabled, consecutive_failures, created_by, created_at, updated_at)
         VALUES ('auto-norm', 'Legacy', '  Acme ', ' Web-App ', 'main', 7, 'x', 'schedule', 'UTC',
                 'anthropic/claude-sonnet-4-6', 1, 0, 'user-1', 1000, 2000)`
      ).run();
      await store.create(
        makeAutomation({
          id: "auto-deleted",
          deleted_at: Date.now(),
        })
      );
      await store.create(
        makeAutomation({
          id: "auto-repoless",
          repo_owner: null,
          repo_name: null,
          base_branch: null,
          repo_id: null,
        })
      );

      await replayBackfill();

      const rows = await store.getRepositoriesForAutomation("auto-norm");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        repo_owner: "acme",
        repo_name: "web-app",
        repo_id: 7,
        base_branch: "main",
        created_at: 1000,
        updated_at: 2000,
      });
      expect(await store.getRepositoriesForAutomation("auto-deleted")).toHaveLength(0);
      expect(await store.getRepositoriesForAutomation("auto-repoless")).toHaveLength(0);

      // Idempotent: replaying the backfill neither duplicates nor overwrites.
      await store.replaceRepositories("auto-norm", [
        { repo_owner: "acme", repo_name: "renamed", repo_id: 8, base_branch: null },
      ]);
      await replayBackfill();
      const after = await store.getRepositoriesForAutomation("auto-norm");
      expect(after).toHaveLength(1);
      expect(after[0].repo_name).toBe("renamed");
    });

    it("handles a 10k-run history with set-based statements", async () => {
      const store = new AutomationStore(env.DB);
      await store.create(makeAutomation({ id: "auto-bulk" }));

      const total = 10_000;
      const chunkSize = 500;
      for (let offset = 0; offset < total; offset += chunkSize) {
        const values: string[] = [];
        for (let i = offset; i < offset + chunkSize; i++) {
          const status = i % 7 === 0 ? "failed" : "completed";
          values.push(
            `('run-bulk-${i}', 'auto-bulk', NULL, '${status}', NULL, NULL, ${i}, NULL, ${i + 50}, ${i}, NULL, NULL, NULL)`
          );
        }
        await env.DB.prepare(
          `INSERT INTO automation_runs
           (id, automation_id, session_id, status, skip_reason, failure_reason,
            scheduled_at, started_at, completed_at, created_at, trigger_key,
            concurrency_key, trigger_run_metadata)
           VALUES ${values.join(", ")}`
        ).run();
      }

      await replayBackfill();

      expect(await countRows("automation_invocations")).toBe(total);
      expect(await countRows("automation_runs", "invocation_id IS NULL")).toBe(0);
      expect(await countRows("automation_invocations", "failure_counted_at IS NOT NULL")).toBe(
        await countRows("automation_runs", "status = 'failed'")
      );

      const { invocations, total: listTotal } = await store.listInvocations("auto-bulk", {
        limit: 20,
        offset: 0,
      });
      expect(listTotal).toBe(total);
      expect(invocations).toHaveLength(20);
      expect(invocations[0].runs).toHaveLength(1);
    });
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
        advanceSchedule: { nextRunAt: 2_000 },
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
        advanceSchedule: { nextRunAt: 3_000 },
      });

      // The 0-row guarded INSERT is a success, not an error: D1 batch() does
      // NOT roll back, children are 0-row no-ops, and the unconditional
      // advance still applies. This is the real-D1 verification of the
      // meta.changes-per-statement semantics the scheduler depends on.
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
        advanceSchedule: { nextRunAt: 2_000 },
      });

      const duplicateSlot = makeInvocation("auto-g4", { source: "schedule", scheduled_at: 1_000 });
      let caught: unknown = null;
      try {
        await store.insertInvocationGuarded({
          invocation: duplicateSlot,
          children: [makeChild("auto-g4", { repo_owner: "acme", repo_name: "api" })],
          overlapScope: { kind: "automation" },
          advanceSchedule: { nextRunAt: 9_999 },
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
        { nextRunAt: 2_000 }
      );

      expect(inserted).toBe(true);
      expect((await store.getById("auto-s1"))!.next_run_at).toBe(2_000);
      expect(await countRows("automation_invocations", "skip_reason IS NOT NULL")).toBe(1);
    });

    it("still advances when the skip collides with an existing slot (INSERT OR IGNORE)", async () => {
      const store = new AutomationStore(env.DB);
      await store.create(makeAutomation({ id: "auto-s2", next_run_at: 1_000 }));

      await store.insertSkippedInvocation(
        makeInvocation("auto-s2", {
          source: "schedule",
          scheduled_at: 1_000,
          skip_reason: "concurrent_run_active",
        }),
        { nextRunAt: 2_000 }
      );
      const second = await store.insertSkippedInvocation(
        makeInvocation("auto-s2", {
          source: "schedule",
          scheduled_at: 1_000,
          skip_reason: "concurrent_run_active",
        }),
        { nextRunAt: 3_000 }
      );

      // The duplicate skip is ignored, but the advance MUST apply — a lost
      // advance re-collides on (automation_id, scheduled_at) every tick.
      expect(second.inserted).toBe(false);
      expect((await store.getById("auto-s2"))!.next_run_at).toBe(3_000);
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

    it("bulkFailRuns only fails active runs", async () => {
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

      await store.bulkFailRuns([done.id, stuck.id], "timeout", 999);

      const statuses = await env.DB.prepare(
        `SELECT id, status FROM automation_runs WHERE invocation_id = ?`
      )
        .bind(invocation.id)
        .all<{ id: string; status: string }>();
      const byId = new Map(statuses.results!.map((row) => [row.id, row.status]));
      expect(byId.get(done.id)).toBe("completed");
      expect(byId.get(stuck.id)).toBe("failed");
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

  describe("repository scalar mirror (transitional dual-write)", () => {
    it("mirrors a single repository onto the automations row and clears it for multi", async () => {
      const store = new AutomationStore(env.DB);
      await store.create(makeAutomation({ id: "auto-mirror" }));

      await store.replaceRepositories("auto-mirror", [
        { repo_owner: "acme", repo_name: "api", repo_id: 5, base_branch: "develop" },
      ]);
      let row = await store.getById("auto-mirror");
      expect(row).toMatchObject({
        repo_owner: "acme",
        repo_name: "api",
        repo_id: 5,
        base_branch: "develop",
      });

      await store.replaceRepositories("auto-mirror", [
        { repo_owner: "acme", repo_name: "api", repo_id: 5, base_branch: null },
        { repo_owner: "acme", repo_name: "web", repo_id: 6, base_branch: null },
      ]);
      row = await store.getById("auto-mirror");
      expect(row).toMatchObject({
        repo_owner: null,
        repo_name: null,
        repo_id: null,
        base_branch: null,
      });

      expect(repositoryScalarMirror([])).toEqual({
        repo_owner: null,
        repo_name: null,
        repo_id: null,
        base_branch: null,
      });
    });

    it("toAutomation mirrors repositories[0] only for single-repository automations", async () => {
      const store = new AutomationStore(env.DB);
      await store.create(makeAutomation({ id: "auto-toauto" }));
      await store.replaceRepositories("auto-toauto", [
        { repo_owner: "acme", repo_name: "api", repo_id: 5, base_branch: null },
        { repo_owner: "acme", repo_name: "web", repo_id: 6, base_branch: "develop" },
      ]);

      const row = await store.getById("auto-toauto");
      const repositories = await store.getRepositoriesForAutomation("auto-toauto");
      const { toAutomation } = await import("../../src/db/automation-store");
      const automation = toAutomation(row!, repositories);

      expect(automation.repositories).toEqual([
        { repoOwner: "acme", repoName: "api", repoId: 5, baseBranch: null },
        { repoOwner: "acme", repoName: "web", repoId: 6, baseBranch: "develop" },
      ]);
      expect(automation.repoOwner).toBeNull();
      expect(automation.repoName).toBeNull();
    });
  });

  // ─── Deprecated /runs alias + invocations listing over mixed history ───────

  describe("flattened runs alias over mixed history", () => {
    /**
     * One automation with all three history shapes at once:
     *  - a pre-0030 legacy run, backfilled into an invocation of 1  (t=1000)
     *  - a childless skipped invocation                             (t=2000)
     *  - a multi-repo invocation with two children                  (t=3000)
     */
    async function seedMixedHistory(automationId: string): Promise<AutomationStore> {
      const store = new AutomationStore(env.DB);
      await store.create(makeAutomation({ id: automationId }));

      await seedLegacyRun({
        id: "run-legacy",
        automation_id: automationId,
        status: "completed",
        scheduled_at: 1_000,
        completed_at: 1_500,
        created_at: 1_000,
        trigger_key: "issue:7",
        concurrency_key: "issue:7",
      });
      await replayBackfill();

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

    it("flattens children, injects virtual skip rows, and counts one row per firing unit", async () => {
      const store = await seedMixedHistory("auto-alias");

      const { runs, total } = await store.listRunsFlattenedForAutomation("auto-alias", {
        limit: 50,
        offset: 0,
      });

      // 3 real runs (legacy + two children) + 1 virtual skip row.
      expect(total).toBe(4);
      expect(runs.map((run) => run.id)).toEqual(["run-api", "run-web", "inv-skip", "run-legacy"]);

      // Virtual row: shaped like a legacy skipped run, id = invocation id.
      const virtualSkip = runs.find((run) => run.id === "inv-skip")!;
      expect(virtualSkip).toMatchObject({
        invocation_id: "inv-skip",
        session_id: null,
        status: "skipped",
        skip_reason: "concurrent_run_active",
        scheduled_at: 2_000,
        repo_owner: null,
        repo_name: null,
      });

      // New-pipeline children surface firing keys from their invocation
      // (their own frozen columns are NULL).
      const child = runs.find((run) => run.id === "run-web")!;
      expect(child.concurrency_key).toBe("firing-key");
      expect(child.repo_owner).toBe("acme");
      expect(child.repo_name).toBe("web-app");

      // Backfilled legacy rows keep their original key values.
      const legacy = runs.find((run) => run.id === "run-legacy")!;
      expect(legacy.trigger_key).toBe("issue:7");
      expect(legacy.concurrency_key).toBe("issue:7");
    });

    it("paginates the flattened view with a stable total", async () => {
      const store = await seedMixedHistory("auto-alias-page");

      const first = await store.listRunsFlattenedForAutomation("auto-alias-page", {
        limit: 2,
        offset: 0,
      });
      const second = await store.listRunsFlattenedForAutomation("auto-alias-page", {
        limit: 2,
        offset: 2,
      });

      expect(first.total).toBe(4);
      expect(second.total).toBe(4);
      expect(first.runs.map((run) => run.id)).toEqual(["run-api", "run-web"]);
      expect(second.runs.map((run) => run.id)).toEqual(["inv-skip", "run-legacy"]);
    });

    it("lists invocations over the same mixed history — one entry per firing", async () => {
      const store = await seedMixedHistory("auto-alias-inv");

      const { invocations, total } = await store.listInvocations("auto-alias-inv", {
        limit: 50,
        offset: 0,
      });

      expect(total).toBe(3);
      expect(invocations.map((invocation) => invocation.id)).toEqual([
        "inv-multi",
        "inv-skip",
        "run-legacy",
      ]);

      const multi = invocations[0];
      expect(multi.status).toBe("completed");
      expect(multi.runs.map((run) => run.repoName)).toEqual(["web-app", "api"]);

      const skip = invocations[1];
      expect(skip.status).toBe("skipped");
      expect(skip.skipReason).toBe("concurrent_run_active");
      expect(skip.runs).toEqual([]);

      const legacy = invocations[2];
      expect(legacy.status).toBe("completed");
      expect(legacy.runs.map((run) => run.id)).toEqual(["run-legacy"]);
    });
  });
});
