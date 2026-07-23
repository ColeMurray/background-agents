/**
 * Subject-token verification for the exchange.
 *
 * The CP verifies the presented provider credential WITH the provider —
 * never trusting asserted claims — and returns the provider's own account
 * identity as the verified subject.
 */

import { z } from "zod";

import { getGitHubUser, GitHubUserApiError } from "./github";
import { createLogger } from "../logger";

const logger = createLogger("subject-verification");

/** The sign-in providers whose subjects the web exchange can verify. */
export type WebAuthProvider = "github" | "google";

export const SUBJECT_TOKEN_TYPES = ["github-access-token", "google-access-token"] as const;
export type SubjectTokenType = (typeof SUBJECT_TOKEN_TYPES)[number];

export interface VerifiedSubject {
  provider: WebAuthProvider;
  providerUserId: string;
  providerLogin?: string;
  providerEmail?: string;
  displayName?: string;
  avatarUrl?: string;
}

export type SubjectVerificationResult =
  | { ok: true; subject: VerifiedSubject }
  /**
   * `subject_rejected`: the provider says the token is invalid (401/403) —
   * the caller's assertion failed verification. `provider_unavailable`: the
   * provider itself failed (5xx/timeout/network) — fail closed, retryable.
   */
  | { ok: false; failure: "subject_rejected" | "provider_unavailable" };

const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const PROVIDER_FETCH_TIMEOUT_MS = 10_000;

const googleUserinfoSchema = z.object({
  sub: z.string().min(1),
  email: z.string().optional(),
  email_verified: z.boolean().optional(),
  name: z.string().optional(),
  picture: z.string().optional(),
});

/** Non-2xx from a provider identity endpoint, carrying the status for classification. */
class ProviderStatusError extends Error {
  constructor(readonly status: number) {
    super(`Provider identity endpoint returned ${status}`);
    this.name = "ProviderStatusError";
  }
}

/**
 * Run one provider identity fetch under the shared contract: a
 * PROVIDER_FETCH_TIMEOUT_MS abort, status classification (< 500 means the
 * subject was rejected, everything else — 5xx/timeout/network/malformed —
 * means the provider failed), and the single failure log site. Per-provider
 * code contributes only the URL/schema/shape mapping.
 */
async function fetchProviderIdentity(
  provider: WebAuthProvider,
  fetchSubject: (signal: AbortSignal) => Promise<VerifiedSubject>
): Promise<SubjectVerificationResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_FETCH_TIMEOUT_MS);
  try {
    return { ok: true, subject: await fetchSubject(controller.signal) };
  } catch (error) {
    const status =
      error instanceof GitHubUserApiError || error instanceof ProviderStatusError
        ? error.status
        : undefined;
    const failure =
      status !== undefined && status < 500 ? "subject_rejected" : "provider_unavailable";
    logger.warn("Subject verification failed", {
      event: "auth.subject_verification_failed",
      provider,
      provider_status: status,
      failure,
    });
    return { ok: false, failure };
  } finally {
    clearTimeout(timer);
  }
}

function verifyGitHubSubject(accessToken: string): Promise<SubjectVerificationResult> {
  return fetchProviderIdentity("github", async (signal) => {
    const user = await getGitHubUser(accessToken, undefined, signal);
    return {
      provider: "github",
      providerUserId: String(user.id),
      providerLogin: user.login,
      providerEmail: user.email ?? undefined,
      displayName: user.name ?? user.login,
      avatarUrl: user.avatar_url,
    };
  });
}

function verifyGoogleSubject(accessToken: string): Promise<SubjectVerificationResult> {
  return fetchProviderIdentity("google", async (signal) => {
    const response = await fetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal,
    });
    if (!response.ok) {
      throw new ProviderStatusError(response.status);
    }
    const parsed = googleUserinfoSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      throw new Error("Malformed Google userinfo response");
    }
    return {
      provider: "google",
      providerUserId: parsed.data.sub,
      providerEmail: parsed.data.email,
      displayName: parsed.data.name,
      avatarUrl: parsed.data.picture,
    };
  });
}

export async function verifySubjectToken(
  subjectTokenType: SubjectTokenType,
  subjectToken: string
): Promise<SubjectVerificationResult> {
  switch (subjectTokenType) {
    case "github-access-token":
      return verifyGitHubSubject(subjectToken);
    case "google-access-token":
      return verifyGoogleSubject(subjectToken);
  }
}
