import type { ProviderCredentialInput } from "./provider-credential";
import type { SignInProvider } from "./sign-in-provider";

export interface StoredBrowserSignInIdentity {
  readonly providerIdentityId: string;
  readonly userId: string;
  readonly provider: SignInProvider;
}

export interface BrowserSignInIdentityProfile {
  readonly provider: SignInProvider;
  readonly issuer: string;
  readonly subject: string;
  readonly login: string | null;
  readonly displayName: string | null;
  readonly avatarUrl: string | null;
  readonly verifiedEmails: readonly string[];
  readonly primaryEmail: string | null;
}

export interface CreateBrowserSignInIdentityInput {
  readonly userId: string;
  readonly providerIdentityId: string;
  readonly profile: BrowserSignInIdentityProfile;
  readonly credential: ProviderCredentialInput | null;
  readonly now: number;
}

export interface RefreshBrowserSignInIdentityInput {
  readonly existing: StoredBrowserSignInIdentity;
  readonly profile: BrowserSignInIdentityProfile;
  readonly credential: ProviderCredentialInput | null;
  readonly now: number;
}

/**
 * Persistence boundary for browser sign-in identity resolution.
 *
 * Implementations own row decoding and the atomic user, identity, email-claim,
 * and provider-credential write batches. The resolver owns evidence
 * validation, immutable subject-binding policy, collision policy, retry policy,
 * and identifier generation.
 */
export interface BrowserSignInIdentityStorePort {
  findByIssuerAndSubject(
    issuer: string,
    subject: string
  ): Promise<StoredBrowserSignInIdentity | null>;
  countConflictingEmails(emails: readonly string[], expectedUserId: string | null): Promise<number>;
  create(input: CreateBrowserSignInIdentityInput): Promise<void>;
  refresh(input: RefreshBrowserSignInIdentityInput): Promise<void>;
  isRetryableCreateConflict(error: unknown): boolean;
  isRetryableRefreshConflict(error: unknown): boolean;
}
