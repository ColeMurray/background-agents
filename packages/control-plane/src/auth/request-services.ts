import type { BetterAuthRuntime } from "./user/runtime";
import type { SqlDatabase } from "../db/sql-database";
import type { CorrelationContext } from "../logger";

/**
 * Narrow request-scoped capabilities required by authentication.
 *
 * Core authentication deliberately depends on this auth-owned port instead
 * of the aggregate route/admission context.
 */
export interface AuthenticationRequestServices extends CorrelationContext {
  db: SqlDatabase;
  getUserAuth?: () => BetterAuthRuntime;
}
