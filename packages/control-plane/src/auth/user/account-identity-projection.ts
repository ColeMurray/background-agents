export interface AccountProjectionInput {
  readonly id: string;
  readonly accountId: string;
  readonly providerId: string;
  readonly userId: string;
  readonly createdAt: Date;
}

/**
 * Projects Better Auth's OAuth accounts into canonical `user_identities` — the
 * forward half of the identity bridge. Bot ingress resolves people by
 * `(provider, subject)`, so every account Better Auth links must appear there
 * or web-first users split into phantom canonical users at their first bot
 * mention.
 *
 * Contract: `project` never throws. It is called from Better Auth database
 * hooks where a thrown error fails the entire sign-in ("unable to link
 * account"), which must never happen for a bookkeeping insert. Failures are
 * logged and repaired by the scheduled reconciliation job.
 */
export interface AccountIdentityProjection {
  project(account: AccountProjectionInput): Promise<void>;
}
