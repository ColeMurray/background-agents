import { isCanonicalUserId } from "@open-inspect/shared/user-id";
import type {
  CanonicalUserProjection,
  UserProjectionInput,
} from "../auth/user/canonical-user-projection";
import { createLogger } from "../logger";
import { isUniqueConstraintError } from "./errors";
import type { SqlDatabase } from "./sql-database";

const logger = createLogger("auth:canonical-user-projection");

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`Canonical user projection ${field} is empty`);
  }
  return normalized;
}

function requireTimestamp(value: Date, field: string): number {
  const timestamp = value.getTime();
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Canonical user projection ${field} is invalid`);
  }
  return timestamp;
}

export class D1CanonicalUserProjection implements CanonicalUserProjection {
  constructor(private readonly db: SqlDatabase) {}

  async project(user: UserProjectionInput): Promise<void> {
    const id = requireNonEmpty(user.id, "id");
    if (!isCanonicalUserId(id)) {
      throw new Error("Projected user id is not canonical");
    }
    const email = requireNonEmpty(user.email, "email").toLowerCase();
    const createdAt = requireTimestamp(user.createdAt, "createdAt");
    const updatedAt = requireTimestamp(user.updatedAt, "updatedAt");

    try {
      await this.db
        .prepare(
          `INSERT INTO users (
             id, display_name, email, avatar_url, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             display_name = excluded.display_name,
             email = excluded.email,
             avatar_url = excluded.avatar_url,
             updated_at = excluded.updated_at`
        )
        .bind(id, user.name.trim() || null, email, user.image ?? null, createdAt, updatedAt)
        .run();
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        // With the sign-in email tier in place this is always a lost race or
        // drift (a concurrent ingress request claimed the email between the
        // tier's lookup and Better Auth's register write), never the steady
        // state — alarm it. The stranded auth graph is bounded by the
        // scheduled reconciliation sweep.
        logger.error("Canonical user projection lost the email to another user", {
          event: "auth.projection_email_conflict",
          user_id: id,
        });
      }
      throw error;
    }
  }
}
