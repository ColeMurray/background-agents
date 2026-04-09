/**
 * Unit tests for automation CRUD route handlers.
 *
 * Tests run in Node (not workerd) with mocked AutomationStore and source
 * control. Handler functions are extracted from the exported automationRoutes
 * array and invoked directly, bypassing the auth middleware.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { automationRoutes } from "./automations";
import type { RequestContext } from "./shared";
import type { Env } from "../types";

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockStore = {
  list: vi.fn(),
  create: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
  softDelete: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  getActiveRunForAutomation: vi.fn(),
  listRunsForAutomation: vi.fn(),
  getRunById: vi.fn(),
};

vi.mock("../db/automation-store", () => ({
  AutomationStore: vi.fn().mockImplementation(() => mockStore),
  toAutomation: vi.fn((row: unknown) => row),
  toAutomationRun: vi.fn((row: unknown) => row),
}));

vi.mock("../auth/crypto", () => ({
  generateId: vi.fn(() => "generated-id"),
}));

vi.mock("./shared", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    resolveRepoOrError: vi.fn().mockResolvedValue({
      repoId: 12345,
      repoOwner: "acme",
      repoName: "web-app",
      defaultBranch: "main",
    }),
  };
});

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Find the handler for a given method + path from automationRoutes. */
function getHandler(method: string, path: string) {
  for (const route of automationRoutes) {
    if (route.method === method && route.pattern.test(path)) {
      const match = path.match(route.pattern)!;
      return { handler: route.handler, match };
    }
  }
  throw new Error(`No route found for ${method} ${path}`);
}

function createEnv(): Env {
  return {
    DB: {} as D1Database,
    SESSION: {} as DurableObjectNamespace,
    SCHEDULER: {
      idFromName: vi.fn().mockReturnValue("fake-id"),
      get: vi.fn().mockReturnValue({
        fetch: vi.fn().mockResolvedValue(Response.json({ run: { id: "run-1" } }, { status: 201 })),
      }),
    } as unknown as DurableObjectNamespace,
    DEPLOYMENT_NAME: "test",
    TOKEN_ENCRYPTION_KEY: "test-key",
  } as Env;
}

function createCtx(): RequestContext {
  return {
    trace_id: "trace-1",
    request_id: "req-1",
    metrics: {
      d1Queries: [],
      spans: {},
      time: async <T>(_name: string, fn: () => Promise<T>) => fn(),
      summarize: () => ({}),
    },
  };
}

async function callRoute(
  method: string,
  path: string,
  options?: { body?: unknown; query?: Record<string, string> }
): Promise<Response> {
  const { handler, match } = getHandler(method, path);
  const url = new URL(`https://test.local${path}`);
  if (options?.query) {
    for (const [k, v] of Object.entries(options.query)) {
      url.searchParams.set(k, v);
    }
  }
  const init: RequestInit = { method };
  if (options?.body) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(options.body);
  }
  return handler(new Request(url, init), createEnv(), match, createCtx());
}

// ─── Sample data ────────────────────────────────────────────────────────────

const now = Date.now();

const sampleRow = {
  id: "auto-1",
  name: "Daily sync",
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
  next_run_at: now,
  consecutive_failures: 0,
  created_by: "user-1",
  created_at: now,
  updated_at: now,
  deleted_at: null,
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("automation route handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /automations (list)", () => {
    it("returns list of automations", async () => {
      mockStore.list.mockResolvedValue({
        automations: [sampleRow],
        total: 1,
      });

      const res = await callRoute("GET", "/automations");
      expect(res.status).toBe(200);

      const body = await res.json<{ automations: unknown[]; total: number }>();
      expect(body.automations).toHaveLength(1);
      expect(body.total).toBe(1);
    });

    it("passes filter params to store", async () => {
      mockStore.list.mockResolvedValue({ automations: [], total: 0 });

      await callRoute("GET", "/automations", {
        query: { repoOwner: "acme", repoName: "web-app" },
      });

      expect(mockStore.list).toHaveBeenCalledWith({
        repoOwner: "acme",
        repoName: "web-app",
      });
    });
  });

  describe("POST /automations (create)", () => {
    const validBody = {
      name: "Daily sync",
      repoOwner: "acme",
      repoName: "web-app",
      scheduleCron: "0 9 * * *",
      scheduleTz: "UTC",
      instructions: "Run tests",
    };

    it("creates automation with valid input", async () => {
      mockStore.create.mockResolvedValue(undefined);
      mockStore.getById.mockResolvedValue(sampleRow);

      const res = await callRoute("POST", "/automations", { body: validBody });
      expect(res.status).toBe(201);
      expect(mockStore.create).toHaveBeenCalledTimes(1);
    });

    it("stores reasoning effort when valid for the selected model", async () => {
      mockStore.create.mockResolvedValue(undefined);
      mockStore.getById.mockResolvedValue({ ...sampleRow, reasoning_effort: "high" });

      const res = await callRoute("POST", "/automations", {
        body: { ...validBody, model: "anthropic/claude-sonnet-4-6", reasoningEffort: "high" },
      });

      expect(res.status).toBe(201);
      expect(mockStore.create).toHaveBeenCalledWith(
        expect.objectContaining({ model: "anthropic/claude-sonnet-4-6", reasoning_effort: "high" })
      );
    });

    it("returns 400 for invalid reasoning effort", async () => {
      const res = await callRoute("POST", "/automations", {
        body: { ...validBody, model: "anthropic/claude-sonnet-4-6", reasoningEffort: "xhigh" },
      });

      expect(res.status).toBe(400);
      const body = await res.json<{ error: string }>();
      expect(body.error).toContain("reasoning");
    });

    it("returns 400 when name is missing", async () => {
      const res = await callRoute("POST", "/automations", {
        body: { ...validBody, name: "" },
      });
      expect(res.status).toBe(400);
      const body = await res.json<{ error: string }>();
      expect(body.error).toContain("name");
    });

    it("returns 400 when name exceeds 200 chars", async () => {
      const res = await callRoute("POST", "/automations", {
        body: { ...validBody, name: "a".repeat(201) },
      });
      expect(res.status).toBe(400);
      const body = await res.json<{ error: string }>();
      expect(body.error).toContain("200");
    });

    it("returns 400 when instructions is missing", async () => {
      const res = await callRoute("POST", "/automations", {
        body: { ...validBody, instructions: "" },
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 when instructions exceeds 10K chars", async () => {
      const res = await callRoute("POST", "/automations", {
        body: { ...validBody, instructions: "x".repeat(10_001) },
      });
      expect(res.status).toBe(400);
      const body = await res.json<{ error: string }>();
      expect(body.error).toContain("10000");
    });

    it("returns 400 when repoOwner is missing", async () => {
      const res = await callRoute("POST", "/automations", {
        body: { ...validBody, repoOwner: "" },
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 for invalid cron expression", async () => {
      const res = await callRoute("POST", "/automations", {
        body: { ...validBody, scheduleCron: "not-a-cron" },
      });
      expect(res.status).toBe(400);
      const body = await res.json<{ error: string }>();
      expect(body.error).toContain("cron");
    });

    it("returns 400 for cron interval under 15 minutes", async () => {
      const res = await callRoute("POST", "/automations", {
        body: { ...validBody, scheduleCron: "*/5 * * * *" },
      });
      expect(res.status).toBe(400);
      const body = await res.json<{ error: string }>();
      expect(body.error).toContain("15 minutes");
    });

    it("returns 400 for invalid timezone", async () => {
      const res = await callRoute("POST", "/automations", {
        body: { ...validBody, scheduleTz: "Not/A/Timezone" },
      });
      expect(res.status).toBe(400);
      const body = await res.json<{ error: string }>();
      expect(body.error).toContain("timezone");
    });
  });

  describe("GET /automations/:id (get)", () => {
    it("returns automation by id", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);

      const res = await callRoute("GET", "/automations/auto-1");
      expect(res.status).toBe(200);

      const body = await res.json<{ automation: typeof sampleRow }>();
      expect(body.automation.id).toBe("auto-1");
    });

    it("returns 404 when not found", async () => {
      mockStore.getById.mockResolvedValue(null);

      const res = await callRoute("GET", "/automations/nonexistent");
      expect(res.status).toBe(404);
    });
  });

  describe("PUT /automations/:id (update)", () => {
    it("updates automation fields", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);
      mockStore.update.mockResolvedValue({ ...sampleRow, name: "Updated" });

      const res = await callRoute("PUT", "/automations/auto-1", {
        body: { name: "Updated" },
      });
      expect(res.status).toBe(200);
      expect(mockStore.update).toHaveBeenCalledWith(
        "auto-1",
        expect.objectContaining({ name: "Updated" })
      );
    });

    it("updates reasoning effort when valid for the selected model", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);
      mockStore.update.mockResolvedValue({ ...sampleRow, reasoning_effort: "high" });

      const res = await callRoute("PUT", "/automations/auto-1", {
        body: { reasoningEffort: "high" },
      });

      expect(res.status).toBe(200);
      expect(mockStore.update).toHaveBeenCalledWith(
        "auto-1",
        expect.objectContaining({ reasoning_effort: "high" })
      );
    });

    it("clears incompatible reasoning effort when model changes", async () => {
      mockStore.getById.mockResolvedValue({ ...sampleRow, reasoning_effort: "max" });
      mockStore.update.mockResolvedValue({
        ...sampleRow,
        model: "openai/gpt-5.4",
        reasoning_effort: null,
      });

      const res = await callRoute("PUT", "/automations/auto-1", {
        body: { model: "openai/gpt-5.4" },
      });

      expect(res.status).toBe(200);
      expect(mockStore.update).toHaveBeenCalledWith(
        "auto-1",
        expect.objectContaining({ model: "openai/gpt-5.4", reasoning_effort: null })
      );
    });

    it("returns 400 for invalid reasoning effort in update", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);

      const res = await callRoute("PUT", "/automations/auto-1", {
        body: { model: "anthropic/claude-sonnet-4-6", reasoningEffort: "xhigh" },
      });

      expect(res.status).toBe(400);
      const body = await res.json<{ error: string }>();
      expect(body.error).toContain("reasoning");
    });

    it("returns 404 when automation not found", async () => {
      mockStore.getById.mockResolvedValue(null);

      const res = await callRoute("PUT", "/automations/missing", {
        body: { name: "Updated" },
      });
      expect(res.status).toBe(404);
    });

    it("returns 400 for invalid cron in update", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);

      const res = await callRoute("PUT", "/automations/auto-1", {
        body: { scheduleCron: "bad" },
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 for empty name in update", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);

      const res = await callRoute("PUT", "/automations/auto-1", {
        body: { name: "" },
      });
      expect(res.status).toBe(400);
    });

    it("recomputes next_run_at when schedule changes", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);
      mockStore.update.mockResolvedValue(sampleRow);

      await callRoute("PUT", "/automations/auto-1", {
        body: { scheduleCron: "0 12 * * *" },
      });

      expect(mockStore.update).toHaveBeenCalledWith(
        "auto-1",
        expect.objectContaining({
          schedule_cron: "0 12 * * *",
          next_run_at: expect.any(Number),
        })
      );
    });
  });

  describe("DELETE /automations/:id", () => {
    it("soft-deletes automation", async () => {
      mockStore.softDelete.mockResolvedValue(true);

      const res = await callRoute("DELETE", "/automations/auto-1");
      expect(res.status).toBe(200);

      const body = await res.json<{ status: string }>();
      expect(body.status).toBe("deleted");
    });

    it("returns 404 when not found", async () => {
      mockStore.softDelete.mockResolvedValue(false);

      const res = await callRoute("DELETE", "/automations/missing");
      expect(res.status).toBe(404);
    });
  });

  describe("POST /automations/:id/pause", () => {
    it("pauses automation", async () => {
      mockStore.pause.mockResolvedValue(true);
      mockStore.getById.mockResolvedValue({ ...sampleRow, enabled: 0 });

      const res = await callRoute("POST", "/automations/auto-1/pause");
      expect(res.status).toBe(200);
      expect(mockStore.pause).toHaveBeenCalledWith("auto-1");
    });

    it("returns 404 when not found", async () => {
      mockStore.pause.mockResolvedValue(false);

      const res = await callRoute("POST", "/automations/missing/pause");
      expect(res.status).toBe(404);
    });
  });

  describe("POST /automations/:id/resume", () => {
    it("resumes automation and recomputes next_run_at", async () => {
      mockStore.getById.mockResolvedValue({ ...sampleRow, enabled: 0 });
      mockStore.resume.mockResolvedValue(true);

      const res = await callRoute("POST", "/automations/auto-1/resume");
      expect(res.status).toBe(200);
      expect(mockStore.resume).toHaveBeenCalledWith("auto-1", expect.any(Number));
    });

    it("returns 404 when not found", async () => {
      mockStore.getById.mockResolvedValue(null);

      const res = await callRoute("POST", "/automations/missing/resume");
      expect(res.status).toBe(404);
    });

    it("returns 400 when automation has no cron schedule", async () => {
      mockStore.getById.mockResolvedValue({
        ...sampleRow,
        schedule_cron: null,
      });

      const res = await callRoute("POST", "/automations/auto-1/resume");
      expect(res.status).toBe(400);
      const body = await res.json<{ error: string }>();
      expect(body.error).toContain("no cron schedule");
    });
  });

  describe("POST /automations/:id/trigger", () => {
    it("triggers automation via SchedulerDO", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);
      mockStore.getActiveRunForAutomation.mockResolvedValue(null);

      const res = await callRoute("POST", "/automations/auto-1/trigger");
      expect(res.status).toBe(201);
    });

    it("returns 404 when automation not found", async () => {
      mockStore.getById.mockResolvedValue(null);

      const res = await callRoute("POST", "/automations/missing/trigger");
      expect(res.status).toBe(404);
    });

    it("returns 409 when SchedulerDO reports active run", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);

      // Override the SCHEDULER stub to return 409 (concurrency check lives in the DO)
      const env = createEnv();
      (env.SCHEDULER!.get as ReturnType<typeof vi.fn>).mockReturnValue({
        fetch: vi
          .fn()
          .mockResolvedValue(Response.json({ error: "concurrent_run_active" }, { status: 409 })),
      });

      const { handler, match } = getHandler("POST", "/automations/auto-1/trigger");
      const request = new Request("https://test.local/automations/auto-1/trigger", {
        method: "POST",
      });
      const res = await handler(request, env, match, createCtx());
      expect(res.status).toBe(409);
    });
  });

  describe("GET /automations/:id/runs (list runs)", () => {
    it("returns runs for automation", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);
      mockStore.listRunsForAutomation.mockResolvedValue({
        runs: [{ id: "run-1", status: "completed" }],
        total: 1,
      });

      const res = await callRoute("GET", "/automations/auto-1/runs");
      expect(res.status).toBe(200);

      const body = await res.json<{ runs: unknown[]; total: number }>();
      expect(body.runs).toHaveLength(1);
      expect(body.total).toBe(1);
    });

    it("returns 404 when automation not found", async () => {
      mockStore.getById.mockResolvedValue(null);

      const res = await callRoute("GET", "/automations/missing/runs");
      expect(res.status).toBe(404);
    });

    it("respects limit and offset params", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);
      mockStore.listRunsForAutomation.mockResolvedValue({ runs: [], total: 0 });

      await callRoute("GET", "/automations/auto-1/runs", {
        query: { limit: "5", offset: "10" },
      });

      expect(mockStore.listRunsForAutomation).toHaveBeenCalledWith("auto-1", {
        limit: 5,
        offset: 10,
      });
    });

    it("caps limit at 100", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);
      mockStore.listRunsForAutomation.mockResolvedValue({ runs: [], total: 0 });

      await callRoute("GET", "/automations/auto-1/runs", {
        query: { limit: "999" },
      });

      expect(mockStore.listRunsForAutomation).toHaveBeenCalledWith("auto-1", {
        limit: 100,
        offset: 0,
      });
    });
  });

  describe("GET /automations/:id/runs/:runId (get run)", () => {
    it("returns a specific run", async () => {
      mockStore.getRunById.mockResolvedValue({ id: "run-1", status: "completed" });

      const res = await callRoute("GET", "/automations/auto-1/runs/run-1");
      expect(res.status).toBe(200);

      const body = await res.json<{ run: { id: string } }>();
      expect(body.run.id).toBe("run-1");
    });

    it("returns 404 when run not found", async () => {
      mockStore.getRunById.mockResolvedValue(null);

      const res = await callRoute("GET", "/automations/auto-1/runs/missing");
      expect(res.status).toBe(404);
    });
  });
});
