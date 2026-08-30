import type { SignInProvider } from "@open-inspect/shared/sign-in-provider";
import { createLogger } from "../../logger";
import { normalizeEmail } from "../../db/email";
import type { IdentityClaimStore } from "../../db/identity-claim-store";
import type { ProviderProfile, ProviderProfileResolver } from "./provider-profile";

const logger = createLogger("auth:sign-in-claim");

/**
 * Claim-at-first-login decorator around the provider profile resolvers.
 *
 * Better Auth persists directly into the canonical registry — a bot-created
 * identity IS an account, so `findOAuthUser`'s account-first lookup signs
 * bot-first users into their canonical row natively. What remains is
 * proof-keeping for the rows that lack it: GitHub ingress creates canonical rows NULL-email, and
 * non-attesting attribution leaves `email_verified = 0` (Slack/Linear
 * ingress is attested — see `EMAIL_ATTESTING_PROVIDERS` in `db/user-store.ts`
 * — so their rows normally arrive already verified). The OAuth callback is
 * the one moment a provider-verified email is in hand, so this decorator
 * runs just before Better Auth's own queries and:
 *
 * - **Subject claim**: the incoming subject already has an identity row —
 *   backfill the canonical row's NULL email (and verify it) from the OAuth
 *   proof. If a *different* canonical user owns that email, skip and event
 *   (`auth.subject_email_collision`): the sign-in still lands account-first
 *   on the subject's row, and the divergent pair is operator merge work.
 * - **Email claim**: no identity row for the subject — normalize the owning
 *   canonical row's legacy email form (Better Auth's lookup is exact-match
 *   lowercase) and mint `email_verified = 1` from the proof so the implicit
 *   linking gate (`requireLocalEmailVerified`) admits the link. Beyond
 *   attested ingress, OAuth proof here is the only verification source.
 *
 * Contract: the inner profile is always returned unchanged, and inner
 * failures (admission denials) propagate untouched. Claim failures are
 * logged and swallowed — worst case is the undecorated behavior.
 */
export class SignInClaim {
  constructor(private readonly store: IdentityClaimStore) {}

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

    const identityOwnerId = await this.store.findIdentityOwnerId(provider, subject);
    if (identityOwnerId) {
      await this.subjectClaim(provider, subject, identityOwnerId, email);
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
    const target = await this.store.getEmailState(targetUserId);
    if (!target) return;

    const targetEmail = normalizeEmail(target.email);
    if (targetEmail === null) {
      const emailOwnerId = await this.store.findEmailOwnerId(email);
      if (emailOwnerId !== null && emailOwnerId !== targetUserId) {
        // Divergent multi-surface pair: one canonical row owns this person's
        // provider subject (e.g. bot-created from GitHub, no email) while a
        // different row owns their email (e.g. Slack-created). The sign-in
        // proceeds account-first onto the subject's row; converging the pair
        // is operator merge work (scripts/merge-split-users.ts).
        logger.warn("Subject and verified email belong to different canonical users", {
          event: "auth.subject_email_collision",
          provider,
          subject,
          subject_user_id: targetUserId,
          email_owner_user_id: emailOwnerId,
        });
        return;
      }
      if (await this.store.claimEmail(targetUserId, email)) {
        logger.info("Claimed NULL-email canonical row with verified sign-in email", {
          event: "auth.email_claimed",
          provider,
          user_id: targetUserId,
        });
      }
      return;
    }

    if (targetEmail === email && !target.emailVerified) {
      await this.store.verifyEmail(targetUserId, email);
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
    await this.store.normalizeStoredEmail(email);

    const verifiedUserId = await this.store.verifyEmailOwner(email);
    if (verifiedUserId !== null) {
      logger.info("Verified canonical email owner ahead of implicit link", {
        event: "auth.email_claim_verified",
        user_id: verifiedUserId,
        mode: "pre-link",
      });
    }
  }
}
