import type { SignInProvider } from "@open-inspect/shared/sign-in-provider";
import { createLogger } from "../../logger";
import { normalizeEmail } from "../../db/email";
import type { SqlDatabase } from "../../db/sql-database";
import type { ProviderProfile, ProviderProfileResolver } from "./provider-profile";

const logger = createLogger("auth:sign-in-claim");

/**
 * Claim-at-first-login decorator around the provider profile resolvers.
 *
 * With Better Auth persisting directly into the canonical registry, no
 * materialization or bridging is needed — a bot-created identity IS an
 * account, so `findOAuthUser`'s account-first lookup signs bot-first users
 * into their canonical row natively. What no framework can do is trust
 * bot-attributed data: canonical rows are created NULL-email (GitHub ingress)
 * or with an unproven email (Slack/Linear ingress, `email_verified = 0`).
 * The OAuth callback is the one moment a provider-verified email is in hand,
 * so this decorator runs just before Better Auth's own queries and:
 *
 * - **Subject claim**: the incoming subject already has an identity row —
 *   backfill the canonical row's NULL email (and verify it) from the OAuth
 *   proof. If a *different* canonical user owns that email, skip and event
 *   (`auth.subject_email_collision`): the sign-in still lands account-first
 *   on the subject's row, and the divergent pair is operator merge work.
 * - **Email claim**: no identity row for the subject — normalize the owning
 *   canonical row's legacy email form (Better Auth's lookup is exact-match
 *   lowercase) and mint `email_verified = 1` from the proof so the implicit
 *   linking gate (`requireLocalEmailVerified`) admits the link. Verification
 *   is minted here and only here (decision 4); bot ingress always writes 0.
 *
 * Contract: the inner profile is always returned unchanged, and inner
 * failures (admission denials) propagate untouched. Claim failures are
 * logged and swallowed — worst case is the undecorated behavior.
 */
export class SignInClaim {
  constructor(private readonly db: SqlDatabase) {}

  wrapResolver(provider: SignInProvider, inner: ProviderProfileResolver): ProviderProfileResolver {
    return async (tokens) => {
      const profile = await inner(tokens);
      if (!profile) return profile;
      try {
        await this.claim(provider, profile);
      } catch (error) {
        logger.error("Sign-in claim failed; continuing sign-in unchanged", {
          event: "auth.claim_failed",
          provider,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return profile;
    };
  }

  private async claim(provider: SignInProvider, profile: ProviderProfile): Promise<void> {
    const subject = profile.user.id?.trim();
    const email = normalizeEmail(profile.user.email);
    // Without a provider-verified email there is nothing to claim.
    if (!subject || !email || !profile.user.emailVerified) return;

    const identity = await this.db
      .prepare(`SELECT user_id FROM user_identities WHERE provider = ? AND provider_user_id = ?`)
      .bind(provider, subject)
      .first<{ user_id: string }>();

    if (identity) {
      await this.subjectClaim(provider, subject, identity.user_id, email);
      return;
    }
    await this.emailClaim(email);
  }

  /**
   * The subject's canonical row exists (bot-first or returning user): give it
   * the just-proven email if it has none, or the verification if the proven
   * email matches an unproven one.
   */
  private async subjectClaim(
    provider: SignInProvider,
    subject: string,
    targetUserId: string,
    email: string
  ): Promise<void> {
    const target = await this.db
      .prepare(`SELECT email, email_verified FROM users WHERE id = ?`)
      .bind(targetUserId)
      .first<{ email: string | null; email_verified: number }>();
    if (!target) return;

    const targetEmail = normalizeEmail(target.email);
    if (targetEmail === null) {
      const owner = await this.db
        .prepare(`SELECT id FROM users WHERE email IS NOT NULL AND lower(trim(email)) = ?`)
        .bind(email)
        .first<{ id: string }>();
      if (owner && owner.id !== targetUserId) {
        // Divergent multi-surface pair (cohort 6): the subject's row and the
        // email's owner are different people-rows. The sign-in proceeds
        // account-first onto the subject's row; the pair is merge work.
        logger.warn("Subject and verified email belong to different canonical users", {
          event: "auth.subject_email_collision",
          provider,
          subject,
          subject_user_id: targetUserId,
          email_owner_user_id: owner.id,
        });
        return;
      }
      const claimed = await this.db
        .prepare(
          `UPDATE OR IGNORE users
           SET email = ?, email_verified = 1, updated_at = ?
           WHERE id = ? AND email IS NULL`
        )
        .bind(email, Date.now(), targetUserId)
        .run();
      if (claimed.meta.changes > 0) {
        logger.info("Claimed NULL-email canonical row with verified sign-in email", {
          event: "auth.email_claimed",
          provider,
          user_id: targetUserId,
        });
      }
      return;
    }

    if (targetEmail === email && target.email_verified === 0) {
      await this.db
        .prepare(
          `UPDATE users SET email_verified = 1, updated_at = ?
           WHERE id = ? AND lower(trim(email)) = ?`
        )
        .bind(Date.now(), targetUserId, email)
        .run();
      logger.info("Verified canonical email from completed OAuth proof", {
        event: "auth.email_claim_verified",
        provider,
        user_id: targetUserId,
      });
    }
    // A differing non-null canonical email is left alone: the sign-in lands
    // account-first regardless, and re-shaping attributed emails is not this
    // decorator's job.
  }

  /**
   * First sign-in with this subject: prepare the email-owning canonical row
   * (if any) for Better Auth's email lookup and linking gate. No owner means
   * a genuinely new person — the register path proceeds untouched.
   */
  private async emailClaim(email: string): Promise<void> {
    // Legacy rows may hold an unnormalized form idx_users_email's NOCASE
    // matches but Better Auth's exact lookup would miss — registering a
    // whitespace-variant duplicate instead of linking. Normalize first.
    await this.db
      .prepare(
        `UPDATE OR IGNORE users SET email = lower(trim(email)), updated_at = ?
         WHERE email IS NOT NULL AND lower(trim(email)) = ? AND email <> lower(trim(email))`
      )
      .bind(Date.now(), email)
      .run();

    const verified = await this.db
      .prepare(
        `UPDATE users SET email_verified = 1, updated_at = ?
         WHERE email = ? AND email_verified = 0`
      )
      .bind(Date.now(), email)
      .run();
    if (verified.meta.changes > 0) {
      logger.info("Verified canonical email owner ahead of implicit link", {
        event: "auth.email_claim_verified",
        user_id: null,
        mode: "pre-link",
      });
    }
  }
}
