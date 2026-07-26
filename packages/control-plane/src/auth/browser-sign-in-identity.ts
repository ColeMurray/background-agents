import type { ProviderCredentialInput } from "./provider-credential";
import type { ProviderCodeExchangeResult, VerifiedProviderIdentity } from "./providers/types";
import type { SignInProvider } from "./sign-in-provider";
import type {
  BrowserSignInIdentityProfile,
  BrowserSignInIdentityStorePort,
  StoredBrowserSignInIdentity,
} from "./browser-sign-in-identity-store";

const CANONICAL_ISSUERS: Readonly<Record<SignInProvider, string>> = {
  github: "https://github.com",
  google: "https://accounts.google.com",
};
const MAX_RESOLUTION_ATTEMPTS = 3;
const MAX_VERIFIED_EMAIL_CLAIMS = 1_000;

export interface ResolvedBrowserSignInIdentity {
  readonly userId: string;
  readonly providerIdentityId: string;
  readonly isNewUser: boolean;
  readonly collisionCount: number;
}

export interface BrowserSignInIdentityResolverDependencies {
  readonly clock: { now(): number };
  readonly idGenerator: { generate(): string };
  readonly store: BrowserSignInIdentityStorePort;
}

export class InvalidProviderIdentityEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidProviderIdentityEvidenceError";
  }
}

export class AccountLinkRequiredError extends Error {
  constructor(readonly collisionCount: number) {
    super("This verified identity requires explicit account linking");
    this.name = "AccountLinkRequiredError";
  }
}

export class ProviderIdentityAdapterMismatchError extends Error {
  constructor() {
    super("Stored provider identity does not match the authenticating adapter");
    this.name = "ProviderIdentityAdapterMismatchError";
  }
}

function normalizeOptional(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function normalizeIdentityEvidence(
  identity: VerifiedProviderIdentity
): BrowserSignInIdentityProfile {
  if (identity.issuer !== CANONICAL_ISSUERS[identity.provider]) {
    throw new InvalidProviderIdentityEvidenceError(
      "Provider identity issuer is not the configured canonical issuer"
    );
  }
  if (identity.subject.length === 0) {
    throw new InvalidProviderIdentityEvidenceError("Provider identity subject is empty");
  }

  const verifiedEmails = [
    ...new Set(identity.verifiedEmails.map((email) => email.trim().toLowerCase()).filter(Boolean)),
  ];
  if (verifiedEmails.length > MAX_VERIFIED_EMAIL_CLAIMS) {
    throw new InvalidProviderIdentityEvidenceError(
      "Provider identity has too many verified email claims"
    );
  }
  const primaryEmail = identity.primaryEmail?.trim().toLowerCase() || null;
  if (primaryEmail !== null && !verifiedEmails.includes(primaryEmail)) {
    throw new InvalidProviderIdentityEvidenceError(
      "Primary display email is not provider-verified"
    );
  }

  return {
    provider: identity.provider,
    issuer: identity.issuer,
    subject: identity.subject,
    login: normalizeOptional(identity.login),
    displayName: normalizeOptional(identity.displayName),
    avatarUrl: normalizeOptional(identity.avatarUrl),
    verifiedEmails,
    primaryEmail,
  };
}

function requireGeneratedId(value: string, kind: string): string {
  if (value.length === 0) {
    throw new Error(`Provider identity ${kind} generator returned an invalid id`);
  }
  return value;
}

/**
 * Resolves a verified browser sign-in to a canonical user by exact
 * (issuer, subject). Existing bindings are refreshed but never silently
 * reparented; cross-user verified-email collisions require explicit linking.
 */
export class BrowserSignInIdentityResolver {
  constructor(private readonly dependencies: BrowserSignInIdentityResolverDependencies) {}

  async resolve(
    signIn: ProviderCodeExchangeResult<SignInProvider>
  ): Promise<ResolvedBrowserSignInIdentity> {
    const identity = normalizeIdentityEvidence(signIn.identity);
    const credential = signIn.credential;

    for (let attempt = 1; attempt <= MAX_RESOLUTION_ATTEMPTS; attempt += 1) {
      const existing = await this.dependencies.store.findByIssuerAndSubject(
        identity.issuer,
        identity.subject
      );
      if (existing) {
        try {
          return await this.refreshExisting(existing, identity, credential);
        } catch (error) {
          if (
            attempt === MAX_RESOLUTION_ATTEMPTS ||
            !this.dependencies.store.isRetryableRefreshConflict(error)
          ) {
            throw error;
          }
          continue;
        }
      }

      const collisionCount = await this.dependencies.store.countConflictingEmails(
        identity.verifiedEmails,
        null
      );
      if (collisionCount > 0) {
        throw new AccountLinkRequiredError(collisionCount);
      }

      try {
        return await this.createIdentity(identity, credential);
      } catch (error) {
        if (
          attempt === MAX_RESOLUTION_ATTEMPTS ||
          !this.dependencies.store.isRetryableCreateConflict(error)
        ) {
          throw error;
        }
      }
    }

    throw new Error("Provider identity resolution exhausted its retry budget");
  }

  private async createIdentity(
    identity: BrowserSignInIdentityProfile,
    credential: ProviderCredentialInput | null
  ): Promise<ResolvedBrowserSignInIdentity> {
    const now = this.dependencies.clock.now();
    const userId = requireGeneratedId(this.dependencies.idGenerator.generate(), "user id");
    const providerIdentityId = requireGeneratedId(
      this.dependencies.idGenerator.generate(),
      "identity id"
    );

    await this.dependencies.store.create({
      userId,
      providerIdentityId,
      profile: identity,
      credential,
      now,
    });

    return {
      userId,
      providerIdentityId,
      isNewUser: true,
      collisionCount: 0,
    };
  }

  private async refreshExisting(
    existing: StoredBrowserSignInIdentity,
    identity: BrowserSignInIdentityProfile,
    credential: ProviderCredentialInput | null
  ): Promise<ResolvedBrowserSignInIdentity> {
    if (existing.provider !== identity.provider) {
      throw new ProviderIdentityAdapterMismatchError();
    }

    const now = this.dependencies.clock.now();
    await this.dependencies.store.refresh({
      existing,
      profile: identity,
      credential,
      now,
    });
    return {
      userId: existing.userId,
      providerIdentityId: existing.providerIdentityId,
      isNewUser: false,
      collisionCount: await this.dependencies.store.countConflictingEmails(
        identity.verifiedEmails,
        existing.userId
      ),
    };
  }
}
