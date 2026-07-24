/**
 * The provider-verified token exchange: verify the presented
 * subject with its provider, resolve the canonical user, capture SCM
 * credentials, and mint a web session token pair. Lives beside
 * WebSessionTokenService so P2's public OAuth surface can reuse the same
 * sequence without going through the internal route.
 */

import {
  verifySubjectToken,
  type SubjectTokenType,
  type WebAuthProvider,
} from "./subject-verification";
import type { WebSessionTokenService, WebSessionTokenPair } from "./web-session-tokens";
import type { SqlDatabase } from "../db/sql-database";
import { UserStore } from "../db/user-store";
import { UserScmTokenStore, DEFAULT_TOKEN_LIFETIME_MS } from "../db/user-scm-tokens";

export interface ExchangeRequest {
  subjectTokenType: SubjectTokenType;
  subjectToken: string;
  scmRefreshToken?: string;
  scmTokenExpiresAt?: number;
}

export type ExchangeResult =
  | { ok: true; userId: string; provider: WebAuthProvider; pair: WebSessionTokenPair }
  | { ok: false; failure: "subject_rejected" | "provider_unavailable" };

/**
 * Run the exchange. SCM capture is awaited — a failure fails the exchange
 * (fail closed) rather than minting tokens for a user whose credentials were
 * silently dropped.
 */
export async function performExchange(
  request: ExchangeRequest,
  db: SqlDatabase,
  tokenService: WebSessionTokenService,
  tokenEncryptionKey: string | undefined
): Promise<ExchangeResult> {
  const verification = await verifySubjectToken(request.subjectTokenType, request.subjectToken);
  if (!verification.ok) {
    return { ok: false, failure: verification.failure };
  }
  const subject = verification.subject;

  // Resolve the canonical user from the VERIFIED identity — this is the
  // identity-creating path for web, replacing trust in body fields.
  const user = await new UserStore(db).resolveOrCreateUser({
    provider: subject.provider,
    providerUserId: subject.providerUserId,
    providerLogin: subject.providerLogin,
    providerEmail: subject.providerEmail,
    displayName: subject.displayName,
    avatarUrl: subject.avatarUrl,
  });

  // Capture SCM credentials once, keyed by the provider-verified id — the
  // same store session-create feeds today, now from a verified source.
  if (subject.provider === "github" && request.scmRefreshToken && tokenEncryptionKey) {
    await new UserScmTokenStore(db, tokenEncryptionKey).upsertTokens(
      subject.providerUserId,
      request.subjectToken,
      request.scmRefreshToken,
      request.scmTokenExpiresAt ?? Date.now() + DEFAULT_TOKEN_LIFETIME_MS,
      user.id
    );
  }

  const pair = await tokenService.mintPair(user.id, {
    provider: subject.provider,
    providerUserId: subject.providerUserId,
  });

  return { ok: true, userId: user.id, provider: subject.provider, pair };
}
