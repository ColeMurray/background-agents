import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SqlDatabase, SqlResult, SqlStatement } from "./db/sql-database";
import type { Env } from "./types";

const { testLogger } = vi.hoisted(() => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  return { testLogger: logger };
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
  beforeEach(() => vi.clearAllMocks());

  it("runs the review reaper and records metrics without a Scheduler binding", async () => {
    const events: string[] = [];
    const env = { DB: createEmptyDb(events) } as unknown as Env;

    await worker.scheduled(minuteEvent(), env, {} as ExecutionContext);

    expect(events.some((query) => query.includes("FROM github_review_sessions"))).toBe(true);
    expect(testLogger.info).toHaveBeenCalledWith(
      "review_reaper.tick",
      expect.objectContaining({ d1_query_count: 1 })
    );
  });

  it("runs the scheduler first and still reaps when its tick throws", async () => {
    const events: string[] = [];
    const schedulerFetch = vi.fn(async () => {
      events.push("scheduler");
      throw new Error("tick unavailable");
    });
    const env = {
      DB: createEmptyDb(events),
      SCHEDULER: {
        idFromName: vi.fn(() => "scheduler-id"),
        get: vi.fn(() => ({ fetch: schedulerFetch })),
      },
    } as unknown as Env;

    await worker.scheduled(minuteEvent(), env, {} as ExecutionContext);

    expect(events[0]).toBe("scheduler");
    expect(events.some((event) => event.includes("FROM github_review_sessions"))).toBe(true);
    expect(testLogger.warn).toHaveBeenCalledWith(
      "Scheduler tick failed",
      expect.objectContaining({ event: "scheduler.tick_failed", error: "tick unavailable" })
    );
    expect(testLogger.info).toHaveBeenCalledWith(
      "review_reaper.tick",
      expect.objectContaining({ d1_query_count: 1 })
    );
  });
});
