import type { ResolvedIdentity } from "../auth/principal";
import { normalizeEmail } from "../db/email";
import type { IdentityClaimStore } from "../db/identity-claim-store";
import { isEmailAttestingProvider, type UserStore } from "../db/user-store";
import { createLogger } from "../logger";
import type { ServiceActorProfileClaims } from "../routes/shared";

const logger = createLogger("router:known-actor-profile");

export type KnownActor = ResolvedIdentity & { canonicalUserId: string };

/**
 * Profile claims for a service actor whose identity already exists.
 *
 * First contact builds the actor's user from its bot's claims and may link it
 * to an existing user by attested email (`UserStore.resolveOrCreateUser`). But
 * an actor is often first seen on a request that carries no claims, such as
 * the Slack bot's catalog reads before a launch, so later claim-bearing
 * requests must still complete the profile. A known actor's user may already
 * hold sessions and grants, so this only fills what the user lacks and never
 * moves the identity:
 *
 * - A missing display name or avatar is set; an existing one is kept.
 * - A missing email is claimed, verified, when the provider attests it and no
 *   other user owns it — what first contact would have stored. When another
 *   user owns it, the pair is a split for operator merge, reported as in the
 *   sign-in claim (`auth.subject_email_collision`), never a relink.
 *
 * Errors propagate; the caller decides whether the request survives them.
 */
export class KnownActorProfileClaim {
  constructor(
    private readonly users: UserStore,
    private readonly claimStore: IdentityClaimStore
  ) {}

  async claim(actor: KnownActor, profile: ServiceActorProfileClaims): Promise<void> {
    // One read decides what is missing, so a complete profile costs no writes;
    // the guarded writes stay authoritative if another writer gets there first.
    const user = await this.users.getUserById(actor.canonicalUserId);
    if (!user) return;
    await this.users.fillMissingProfile(actor.canonicalUserId, {
      displayName: user.displayName?.trim() ? undefined : profile.displayName,
      avatarUrl: user.avatarUrl?.trim() ? undefined : profile.avatarUrl,
    });
    if (normalizeEmail(user.email) === null) await this.claimEmail(actor, profile.email);
  }

  private async claimEmail(actor: KnownActor, claimedEmail: string | undefined): Promise<void> {
    const email = isEmailAttestingProvider(actor.provider) ? normalizeEmail(claimedEmail) : null;
    if (!email) return;

    const emailOwnerId = await this.claimStore.findEmailOwnerId(email);
    if (emailOwnerId !== null) {
      logger.warn("Actor identity and attested email belong to different canonical users", {
        event: "auth.subject_email_collision",
        provider: actor.provider,
        subject: actor.providerUserId,
        subject_user_id: actor.canonicalUserId,
        email_owner_user_id: emailOwnerId,
      });
      return;
    }
    if (await this.claimStore.claimEmail(actor.canonicalUserId, email)) {
      logger.info("Claimed NULL-email canonical row with attested actor email", {
        event: "auth.email_claimed",
        provider: actor.provider,
        user_id: actor.canonicalUserId,
      });
    }
  }
}
