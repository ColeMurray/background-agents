import { z } from "zod";
import type { SignInProvider } from "@open-inspect/shared/sign-in-provider";
import type { VerifiedProviderIdentity } from "./providers/types";
import type { Env } from "../../types";

export const GITHUB_ORGANIZATION_EVALUATION_TIMEOUT_MS = 10_000;
export const GITHUB_ORGANIZATION_CONCURRENCY = 4;

export interface GitHubAdmissionEvidence {
  readonly identity: VerifiedProviderIdentity<"github">;
  readonly accessToken: string;
}

export interface GoogleAdmissionEvidence {
  readonly identity: VerifiedProviderIdentity<"google">;
}

export type VerifiedProviderSignIn = GitHubAdmissionEvidence | GoogleAdmissionEvidence;

export interface AdmissionPolicyConfig {
  readonly allowedGitHubUsers: readonly string[];
  readonly allowedEmails: readonly string[];
  readonly allowedEmailDomains: readonly string[];
  readonly allowedGitHubOrganizations: readonly string[];
  readonly unsafeAllowAllUsers: boolean;
}

export type AdmissionDecision =
  | { readonly reason: "unsafe_allow_all" }
  | { readonly reason: "github_user_allowlist" }
  | { readonly reason: "email_allowlist" }
  | { readonly reason: "email_domain_allowlist" }
  | { readonly reason: "github_organization"; readonly organization: string };

export interface AdmissionEvaluator {
  requireAdmission(signIn: VerifiedProviderSignIn): Promise<AdmissionDecision>;
}

export interface AdmissionPolicyDependencies {
  readonly fetcher?: typeof fetch;
}

export class AdmissionDeniedError extends Error {
  constructor() {
    super("User is not admitted by this deployment");
    this.name = "AdmissionDeniedError";
  }
}

export class AdmissionUnavailableError extends Error {
  constructor() {
    super("Admission policy could not be evaluated");
    this.name = "AdmissionUnavailableError";
  }
}

const membershipSchema = z.object({
  state: z.enum(["active", "pending"]),
});

function normalize(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))];
}

export function parseAdmissionAllowlist(value: string | undefined): string[] {
  return normalize(value?.split(",") ?? []);
}

export function parseAdmissionBoolean(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

export function admissionPolicyConfigFromEnv(env: Env): AdmissionPolicyConfig {
  return {
    allowedGitHubUsers: parseAdmissionAllowlist(env.ALLOWED_USERS),
    allowedEmails: parseAdmissionAllowlist(env.ALLOWED_EMAILS),
    allowedEmailDomains: parseAdmissionAllowlist(env.ALLOWED_EMAIL_DOMAINS),
    allowedGitHubOrganizations: parseAdmissionAllowlist(env.ALLOWED_GITHUB_ORGS),
    unsafeAllowAllUsers: parseAdmissionBoolean(env.UNSAFE_ALLOW_ALL_USERS),
  };
}

function emailDomain(email: string): string | null {
  const separator = email.lastIndexOf("@");
  if (separator <= 0 || separator === email.length - 1) return null;
  return email.slice(separator + 1).toLowerCase();
}

function isGitHubSignIn(signIn: VerifiedProviderSignIn): signIn is GitHubAdmissionEvidence {
  return signIn.identity.provider === "github";
}

export class AdmissionPolicy {
  private readonly config: AdmissionPolicyConfig;
  private readonly fetcher: typeof fetch;

  constructor(config: AdmissionPolicyConfig, dependencies: AdmissionPolicyDependencies = {}) {
    this.config = {
      allowedGitHubUsers: normalize(config.allowedGitHubUsers),
      allowedEmails: normalize(config.allowedEmails),
      allowedEmailDomains: normalize(config.allowedEmailDomains),
      allowedGitHubOrganizations: normalize(config.allowedGitHubOrganizations),
      unsafeAllowAllUsers: config.unsafeAllowAllUsers,
    };
    this.fetcher = dependencies.fetcher ?? globalThis.fetch.bind(globalThis);
  }

  supportsSignInProvider(provider: SignInProvider): boolean {
    const hasProviderNeutralAdmission =
      this.config.allowedEmails.length > 0 || this.config.allowedEmailDomains.length > 0;
    const hasGitHubAdmission =
      this.config.allowedGitHubUsers.length > 0 ||
      this.config.allowedGitHubOrganizations.length > 0;
    const hasConfiguredAllowlist = hasProviderNeutralAdmission || hasGitHubAdmission;

    if (!hasConfiguredAllowlist && this.config.unsafeAllowAllUsers) return true;
    const providerSupport: Readonly<Record<SignInProvider, boolean>> = {
      github: hasProviderNeutralAdmission || hasGitHubAdmission,
      google: hasProviderNeutralAdmission,
    };
    return providerSupport[provider];
  }

  async requireAdmission(signIn: VerifiedProviderSignIn): Promise<AdmissionDecision> {
    if (this.allowsAllUsers()) return { reason: "unsafe_allow_all" };

    if (
      isGitHubSignIn(signIn) &&
      signIn.identity.login &&
      this.config.allowedGitHubUsers.includes(signIn.identity.login.toLowerCase())
    ) {
      return { reason: "github_user_allowlist" };
    }

    const emailAdmission = this.emailAdmission(signIn.identity.verifiedEmails);
    if (emailAdmission) return emailAdmission;

    if (isGitHubSignIn(signIn) && this.config.allowedGitHubOrganizations.length > 0) {
      return this.requireGitHubOrganization(signIn);
    }
    throw new AdmissionDeniedError();
  }

  /** Bot enrollment has attested emails, but no GitHub sign-in proof. */
  requireBotEnrollment(verifiedEmails: readonly string[]): AdmissionDecision {
    if (this.allowsAllUsers()) return { reason: "unsafe_allow_all" };
    const decision = this.emailAdmission(verifiedEmails);
    if (decision) return decision;
    throw new AdmissionDeniedError();
  }

  private allowsAllUsers(): boolean {
    const hasConfiguredAllowlist =
      this.config.allowedGitHubUsers.length > 0 ||
      this.config.allowedEmails.length > 0 ||
      this.config.allowedEmailDomains.length > 0 ||
      this.config.allowedGitHubOrganizations.length > 0;
    return !hasConfiguredAllowlist && this.config.unsafeAllowAllUsers;
  }

  private emailAdmission(verifiedEmails: readonly string[]): AdmissionDecision | null {
    const emails = normalize(verifiedEmails);
    if (emails.some((email) => this.config.allowedEmails.includes(email))) {
      return { reason: "email_allowlist" };
    }
    if (
      emails.some((email) => {
        const domain = emailDomain(email);
        return domain !== null && this.config.allowedEmailDomains.includes(domain);
      })
    ) {
      return { reason: "email_domain_allowlist" };
    }

    return null;
  }

  private async requireGitHubOrganization(
    signIn: GitHubAdmissionEvidence
  ): Promise<AdmissionDecision> {
    const organizations = this.config.allowedGitHubOrganizations;
    const controller = new AbortController();
    let nextOrganization = 0;
    const checkOrganizations = async (): Promise<AdmissionDecision> => {
      let unavailable = false;
      while (!controller.signal.aborted && nextOrganization < organizations.length) {
        const organization = organizations[nextOrganization++];
        try {
          const response = await this.fetcher(
            `https://api.github.com/user/memberships/orgs/${encodeURIComponent(organization)}`,
            {
              headers: {
                Authorization: `Bearer ${signIn.accessToken}`,
                Accept: "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": "Open-Inspect-Control-Plane",
              },
              signal: controller.signal,
            }
          );
          if (!response.ok) {
            // Free the connection before taking another queued organization.
            await response.body?.cancel();
            if (response.status !== 404) unavailable = true;
            continue;
          }
          const parsed = membershipSchema.safeParse(await response.json().catch(() => null));
          if (!parsed.success) {
            unavailable = true;
            continue;
          }
          if (parsed.data.state === "active" && !controller.signal.aborted) {
            controller.abort();
            return { reason: "github_organization", organization };
          }
        } catch {
          unavailable = true;
        }
      }
      throw unavailable ? new AdmissionUnavailableError() : new AdmissionDeniedError();
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new AdmissionUnavailableError());
        controller.abort();
      }, GITHUB_ORGANIZATION_EVALUATION_TIMEOUT_MS);
    });
    try {
      // Any active membership wins without waiting for earlier slow organizations.
      // The shared deadline covers queued checks and response bodies, not each request.
      return await Promise.race([
        Promise.any(
          Array.from(
            { length: Math.min(GITHUB_ORGANIZATION_CONCURRENCY, organizations.length) },
            checkOrganizations
          )
        ),
        deadline,
      ]);
    } catch (error) {
      if (error instanceof AggregateError) {
        throw error.errors.some((cause) => cause instanceof AdmissionUnavailableError)
          ? new AdmissionUnavailableError()
          : new AdmissionDeniedError();
      }
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
    }
  }
}
