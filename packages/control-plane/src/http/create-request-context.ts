import { getUserAuth, getUserAuthRuntime } from "../auth/user/runtime";
import { createRequestMetrics, instrumentSqlDatabase } from "../db/instrumented-sql-database";
import type { SqlDatabase } from "../db/sql-database";
import type { BackgroundTasks } from "../platform-ports";
import type { Env } from "../types";
import type { RequestContext } from "./request-context";

/** Assemble framework-neutral per-request state after the DB guard passes. */
export function createRequestContext(input: {
  request: Request;
  env: Env;
  database: SqlDatabase;
  executionCtx: BackgroundTasks;
}): RequestContext {
  const { request, env, database, executionCtx } = input;
  const metrics = createRequestMetrics();

  return {
    trace_id: request.headers.get("x-trace-id") || crypto.randomUUID(),
    request_id: crypto.randomUUID().slice(0, 8),
    metrics,
    db: instrumentSqlDatabase(database, metrics),
    // The stable uninstrumented binding remains the Better Auth cache key.
    getUserAuth: () => getUserAuth(env, database),
    getUserAuthRuntime: () => getUserAuthRuntime(env, database),
    executionCtx,
  };
}
