import { getSignInProviderIssuer, isSignInProvider } from "@open-inspect/shared/sign-in-provider";
import { generateId } from "../auth/crypto";
import type {
  AccountIdentityProjection,
  AccountProjectionInput,
} from "../auth/user/account-identity-projection";
import { createLogger } from "../logger";
import type { SqlDatabase } from "./sql-database";

const logger = createLogger("auth:account-identity-projection");

export class D1AccountIdentityProjection implements AccountIdentityProjection {
  constructor(private readonly db: SqlDatabase) {}

  async project(account: AccountProjectionInput): Promise<void> {
    try {
      if (!isSignInProvider(account.providerId)) return;
      const issuer = getSignInProviderIssuer(account.providerId);

      const existing = await this.db
        .prepare(`SELECT user_id FROM user_identities WHERE provider = ? AND provider_user_id = ?`)
        .bind(account.providerId, account.accountId)
        .first<{ user_id: string }>();
      if (existing) {
        if (existing.user_id !== account.userId) {
          // A pre-existing split: the subject's bot identity and its auth
          // account belong to different canonical users. DO-NOTHING semantics
          // preserve it for the R4 report and the merge script instead of
          // silently re-pointing history.
          logger.warn("Auth account subject already owned by another canonical user", {
            event: "auth.identity_projection_conflict",
            provider: account.providerId,
            identity_user_id: existing.user_id,
            account_user_id: account.userId,
          });
        }
        return;
      }

      const createdAt = account.createdAt.getTime();
      const result = await this.db
        .prepare(
          `INSERT INTO user_identities (
             id, user_id, provider, provider_user_id, provider_login,
             provider_email, provider_issuer, created_at
           ) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)
           ON CONFLICT(provider, provider_user_id) DO NOTHING`
        )
        .bind(
          generateId(),
          account.userId,
          account.providerId,
          account.accountId,
          issuer,
          Number.isFinite(createdAt) ? createdAt : Date.now()
        )
        .run();
      if (result.meta.changes > 0) {
        logger.info("Auth account projected into user_identities", {
          event: "auth.identity_projected",
          provider: account.providerId,
          user_id: account.userId,
        });
      }
    } catch (error) {
      logger.error("Auth account identity projection failed", {
        event: "auth.identity_projection_failed",
        provider: account.providerId,
        user_id: account.userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
