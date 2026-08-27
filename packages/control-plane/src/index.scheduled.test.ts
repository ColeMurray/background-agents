import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SqlDatabase, SqlResult, SqlStatement } from "./db/sql-database";
import type { Env } from "./types";

const { testLogger, schedulerTick } = vi.hoisted(() => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  return { testLogger: logger, schedulerTick: vi.fn() };
});

vi.mock("./logger", async (importOriginal) => ({
  ...(await importOriginal()),
  createLogger: () => testLogger,
}));

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown
    ) {}
  },
}));

// The automation Scheduler is a heavyweight, request-driven class unrelated
// to the review reaper this suite exercises. Stub its tick() so these tests
// can control whether it succeeds or throws without standing up automation
// fixtures.
vi.mock("./scheduler/scheduler", () => ({
  Scheduler: class {
    tick = schedulerTick;
  },
}));

const { default: worker } = await import("./index");

function createEmptyDb(events: string[]): SqlDatabase {
  function statement(): SqlStatement {
    return {
      bind: () => statement(),
      first: async () => null,
      run: async <T>() => ({ results: [] as T[], meta: { changes: 0 } }),
      all: async <T>() => ({ results: [] as T[], meta: { changes: 0 } }),
    };
  }

  return {
    prepare(query: string): SqlStatement {
      events.push(query);
      return statement();
    },
    batch: async <T>(statements: SqlStatement[]): Promise<SqlResult<T>[]> =>
      statements.map(() => ({ results: [] as T[], meta: { changes: 0 } })),
  };
}

function minuteEvent(): ScheduledEvent {
  return { cron: "* * * * *" } as ScheduledEvent;
}

describe("minute scheduled handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    schedulerTick.mockResolvedValue(new Response(null, { status: 200 }));
  });

  it("runs the review reaper and records metrics", async () => {
    const events: string[] = [];
    const env = { DB: createEmptyDb(events) } as unknown as Env;

    await worker.scheduled(minuteEvent(), env, {
      waitUntil: vi.fn(),
    } as unknown as ExecutionContext);

    expect(schedulerTick).toHaveBeenCalledTimes(1);
    expect(events.some((query) => query.includes("FROM github_review_sessions"))).toBe(true);
    expect(testLogger.info).toHaveBeenCalledWith(
      "review_reaper.tick",
      expect.objectContaining({ d1_query_count: 1 })
    );
  });

  it("still reaps when the automation scheduler tick throws", async () => {
    const events: string[] = [];
    schedulerTick.mockRejectedValueOnce(new Error("tick unavailable"));
    const env = { DB: createEmptyDb(events) } as unknown as Env;

    await expect(
      worker.scheduled(minuteEvent(), env, { waitUntil: vi.fn() } as unknown as ExecutionContext)
    ).rejects.toThrow("tick unavailable");

    expect(events.some((query) => query.includes("FROM github_review_sessions"))).toBe(true);
    expect(testLogger.error).toHaveBeenCalledWith(
      "Scheduler tick failed",
      expect.objectContaining({ event: "scheduler.tick_failed", error: "tick unavailable" })
    );
    expect(testLogger.info).toHaveBeenCalledWith(
      "review_reaper.tick",
      expect.objectContaining({ d1_query_count: 1 })
    );
  });

  it("still reaps when the review reaper itself throws", async () => {
    const events: string[] = [];
    const db: SqlDatabase = {
      prepare(query: string): SqlStatement {
        events.push(query);
        throw new Error("D1 unavailable");
      },
      batch: async <T>(): Promise<SqlResult<T>[]> => [],
    };
    const env = { DB: db } as unknown as Env;

    await expect(
      worker.scheduled(minuteEvent(), env, { waitUntil: vi.fn() } as unknown as ExecutionContext)
    ).rejects.toThrow("D1 unavailable");

    expect(schedulerTick).toHaveBeenCalledTimes(1);
    expect(testLogger.error).toHaveBeenCalledWith(
      "Review reaper tick failed",
      expect.objectContaining({ event: "review_reaper.tick_failed", error: "D1 unavailable" })
    );
  });

  it("reports both failures after attempting both jobs", async () => {
    schedulerTick.mockRejectedValueOnce(new Error("tick unavailable"));
    const db: SqlDatabase = {
      prepare: () => {
        throw new Error("D1 unavailable");
      },
      batch: async <T>(): Promise<SqlResult<T>[]> => [],
    };
    const env = { DB: db } as unknown as Env;

    await expect(
      worker.scheduled(minuteEvent(), env, { waitUntil: vi.fn() } as unknown as ExecutionContext)
    ).rejects.toThrow("Scheduler tick and review reaper failed");

    expect(testLogger.error).toHaveBeenCalledWith(
      "Scheduler tick failed",
      expect.objectContaining({ error: "tick unavailable" })
    );
    expect(testLogger.error).toHaveBeenCalledWith(
      "Review reaper tick failed",
      expect.objectContaining({ error: "D1 unavailable" })
    );
  });
});
