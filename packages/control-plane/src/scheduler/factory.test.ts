import { expect, it, vi } from "vitest";
import type { SqlDatabase } from "../db/sql-database";
import type { Env } from "../types";
import { createScheduler } from "./factory";

it("constructs scheduler collaborators without starting database or network work", () => {
  const db = {
    prepare: vi.fn<SqlDatabase["prepare"]>(),
    batch: vi.fn(async () => []),
  };
  const fetch = vi.fn();
  const submit = vi.fn();
  const env = { SLACK_BOT: { fetch }, LOG_LEVEL: "error" } as unknown as Env;

  createScheduler(db, env, { submit });

  expect(db.prepare).not.toHaveBeenCalled();
  expect(db.batch).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  expect(submit).not.toHaveBeenCalled();
});
