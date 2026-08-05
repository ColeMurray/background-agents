import type { SignInProvider } from "@open-inspect/shared/sign-in-provider";
import { generateId } from "../crypto";
import { createLogger } from "../../logger";
import type { SqlDatabase } from "../../db/sql-database";
import type { ProviderProfile, ProviderProfileResolver } from "./provider-profile";

const logger = createLogger("auth:sign-in-reconciliation");

/**
 * Two-tier reconciliation decorator around the provider profile resolvers.
 *
 * The OAuth callback is the only moment a provider-verified email and subject
 * are simultaneously in hand, which makes it the one place the canonical
 * registry (bot ingress) and the Better Auth registry can be bridged without
 * trusting bot-attributed data:
 *
 * - **Subject tier**: a canonical user already owns this provider subject
 *   (bot-first, e.g. created from a GitHub mention with no email). Materialize
 *   their auth user + account so Better Auth's account-first lookup signs them
 *   into the canonical id — linking policy never runs.
 * - **Verified-email tier**: a canonical user owns the verified email but has
 *   no linkable auth row (bot-first with email, e.g. Slack-created). Seed or
 *   repair their zero-account auth row with `emailVerified = 1` — minted here
 *   from the completed OAuth proof, never from ingress data — so Better
 *   Auth's email fallback performs the implicit link itself.
 *
 * The email tier runs whenever the subject tier did not complete
 * materialization: no subject match, a deliberate collision skip, or a failed
 * batch. Zero-account scope means the tiers can only recover locked-out
 * identities, never re-shape active ones — once an auth user has accounts,
 * Better Auth is authoritative.
 *
 * Contract: the inner profile is always returned unchanged, and inner
 * failures (admission denials) propagate untouched. Reconciliation failures
 * are logged and swallowed — worst case is the pre-reconciliation behavior.
 */
export class SignInReconciliation {
  constructor(private readonly db: SqlDatabase) {}

  wrapResolver(provider: SignInProvider, inner: ProviderProfileResolver): ProviderProfileResolver {
    return async (tokens) => {
      const profile = await inner(tokens);
      if (!profile) return profile;
      await this.reconcile(provider, profile);
      return profile;
    };
  }

  private async reconcile(provider: SignInProvider, profile: ProviderProfile): Promise<void> {
    const subject = profile.user.id?.trim();
    const email = normalizeEmail(profile.user.email);
    // Without a provider-verified email there is nothing to materialize:
    // auth_users.email is NOT NULL, so no auth row can be created or linked.
    if (!subject || !email || !profile.user.emailVerified) return;

    let materialized = false;
    try {
      materialized = await this.subjectTier(provider, subject, email, profile);
    } catch (error) {
      logger.error("Subject materialization failed; continuing sign-in unchanged", {
        event: "auth.subject_materialization_failed",
        provider,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (materialized) return;

    try {
      await this.emailTier(email, profile);
    } catch (error) {
      logger.error("Verified-email tier failed; continuing sign-in unchanged", {
        event: "auth.email_tier_failed",
        provider,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Returns true when materialization is complete — an `auth_accounts` row
   * exists for the incoming subject — which is the email tier's skip signal.
   */
  private async subjectTier(
    provider: SignInProvider,
    subject: string,
    email: string,
    profile: ProviderProfile
  ): Promise<boolean> {
    const account = await this.db
      .prepare(`SELECT userId FROM auth_accounts WHERE providerId = ? AND accountId = ?`)
      .bind(provider, subject)
      .first<{ userId: string }>();
    // Fully-linked users are a read-only fast path: Better Auth's
    // account-first lookup handles the sign-in.
    if (account) return true;

    const identity = await this.db
      .prepare(`SELECT user_id FROM user_identities WHERE provider = ? AND provider_user_id = ?`)
      .bind(provider, subject)
      .first<{ user_id: string }>();
    if (!identity) return false;
    const targetUserId = identity.user_id;

    // Email authority rule: once the target's auth row bears accounts,
    // Better Auth is authoritative for it — attaching this subject behind its
    // back would bypass the framework's own linking gate. Fall through to the
    // email tier, which respects the same rule.
    const targetAccounts = await this.db
      .prepare(`SELECT COUNT(*) AS count FROM auth_accounts WHERE userId = ?`)
      .bind(targetUserId)
      .first<{ count: number }>();
    if ((targetAccounts?.count ?? 0) > 0) return false;

    const canonicalOwner = await this.db
      .prepare(`SELECT id FROM users WHERE email IS NOT NULL AND lower(trim(email)) = ?`)
      .bind(email)
      .first<{ id: string }>();
    const authOwner = await this.db
      .prepare(`SELECT id FROM auth_users WHERE lower(trim(email)) = ?`)
      .bind(email)
      .first<{ id: string }>();
    const emailOwnerId =
      canonicalOwner && canonicalOwner.id !== targetUserId
        ? canonicalOwner.id
        : authOwner && authOwner.id !== targetUserId
          ? authOwner.id
          : null;
    if (emailOwnerId !== null) {
      // Cohort 6: the subject's canonical user and the verified email's owner
      // are different rows (e.g. a Slack-created row owns the email while the
      // GitHub-created row owns the subject). Materializing would violate
      // auth_users.email UNIQUE. Skip deliberately: the email tier seeds the
      // owner's auth row and implicit linking lands the sign-in there, while
      // this evented shared-subject split waits in the R4 work list for the
      // merge script.
      logger.warn("Subject and verified email belong to different canonical users", {
        event: "auth.subject_email_collision",
        provider,
        subject_user_id: targetUserId,
        email_owner_user_id: emailOwnerId,
      });
      return false;
    }

    const nowIso = new Date().toISOString();
    // One atomic batch — unlike Better Auth's non-atomic D1 fallback, a
    // failure here strands nothing.
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO auth_users (id, name, email, emailVerified, image, createdAt, updatedAt)
           VALUES (?, ?, ?, 1, ?, ?, ?)
           ON CONFLICT(id) DO NOTHING`
        )
        .bind(
          targetUserId,
          profile.user.name?.trim() || email,
          email,
          profile.user.image ?? null,
          nowIso,
          nowIso
        ),
      this.db
        .prepare(
          `INSERT INTO auth_accounts (
             id, accountId, providerId, userId, accessToken, refreshToken,
             idToken, accessTokenExpiresAt, refreshTokenExpiresAt, scope,
             password, createdAt, updatedAt
           ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`
        )
        .bind(generateId(), subject, provider, targetUserId, nowIso, nowIso),
      // GitHub-first canonical rows carry no email; the verified sign-in
      // email is the first trustworthy value they can acquire.
      this.db
        .prepare(`UPDATE users SET email = ?, updated_at = ? WHERE id = ? AND email IS NULL`)
        .bind(email, Date.now(), targetUserId),
    ]);
    logger.info("Materialized auth identity for bot-first canonical user", {
      event: "auth.subject_materialized",
      provider,
      user_id: targetUserId,
    });
    return true;
  }

  private async emailTier(email: string, profile: ProviderProfile): Promise<void> {
    const owner = await this.db
      .prepare(`SELECT id FROM users WHERE email IS NOT NULL AND lower(trim(email)) = ?`)
      .bind(email)
      .first<{ id: string }>();
    // No canonical owner: a genuinely new person — Better Auth's register
    // path proceeds untouched.
    if (!owner) return;

    const authRow = await this.db
      .prepare(
        `SELECT
           auth_users.email AS email,
           auth_users.emailVerified AS emailVerified,
           (SELECT COUNT(*) FROM auth_accounts WHERE auth_accounts.userId = auth_users.id)
             AS accountCount
         FROM auth_users
         WHERE auth_users.id = ?`
      )
      .bind(owner.id)
      .first<{ email: string; emailVerified: number; accountCount: number }>();

    const nowIso = new Date().toISOString();
    if (!authRow) {
      // ON CONFLICT DO NOTHING keeps the two documented edges quiet instead
      // of erroring on every sign-in: a concurrent duplicate seed, and an
      // email still reserved by a canonical-less strand (Better Auth's email
      // fallback then links into the strand until the reconciliation sweep
      // clears it — the accepted §4e edge).
      const seeded = await this.db
        .prepare(
          `INSERT INTO auth_users (id, name, email, emailVerified, image, createdAt, updatedAt)
           VALUES (?, ?, ?, 1, ?, ?, ?)
           ON CONFLICT DO NOTHING`
        )
        .bind(
          owner.id,
          profile.user.name?.trim() || email,
          email,
          profile.user.image ?? null,
          nowIso,
          nowIso
        )
        .run();
      if (seeded.meta.changes > 0) {
        logger.info("Seeded auth user for canonical email owner at sign-in", {
          event: "auth.email_tier_seeded",
          user_id: owner.id,
          mode: "seeded",
        });
      }
      return;
    }

    // Once the row has accounts, Better Auth is authoritative for it; its own
    // linking gate decides this sign-in.
    if (authRow.accountCount > 0) return;
    if (authRow.email === email && authRow.emailVerified === 1) return;

    await this.db
      .prepare(`UPDATE auth_users SET email = ?, emailVerified = 1, updatedAt = ? WHERE id = ?`)
      .bind(email, nowIso, owner.id)
      .run();
    logger.info("Repaired stale zero-account auth user at sign-in", {
      event: "auth.email_tier_seeded",
      user_id: owner.id,
      mode: "repaired",
    });
  }
}

function normalizeEmail(email: string | null | undefined): string | null {
  const normalized = email?.trim().toLowerCase();
  return normalized ? normalized : null;
}
