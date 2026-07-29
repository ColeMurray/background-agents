import { z } from "zod";
import { DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS } from "./providers/constants";
import type { VerifiedProviderIdentity } from "./providers/types";

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

  async requireAdmission(signIn: VerifiedProviderSignIn): Promise<AdmissionDecision> {
    const hasConfiguredAllowlist =
      this.config.allowedGitHubUsers.length > 0 ||
      this.config.allowedEmails.length > 0 ||
      this.config.allowedEmailDomains.length > 0 ||
      this.config.allowedGitHubOrganizations.length > 0;
    if (!hasConfiguredAllowlist && this.config.unsafeAllowAllUsers) {
      return { reason: "unsafe_allow_all" };
    }

    if (
      isGitHubSignIn(signIn) &&
      signIn.identity.login &&
      this.config.allowedGitHubUsers.includes(signIn.identity.login.toLowerCase())
    ) {
      return { reason: "github_user_allowlist" };
    }

    const emails = normalize(signIn.identity.verifiedEmails);
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

    if (isGitHubSignIn(signIn) && this.config.allowedGitHubOrganizations.length > 0) {
      return this.requireGitHubOrganization(signIn);
    }
    throw new AdmissionDeniedError();
  }

  private async requireGitHubOrganization(
    signIn: GitHubAdmissionEvidence
  ): Promise<AdmissionDecision> {
    const accessToken = signIn.accessToken;
    let unavailable = false;

    for (const organization of this.config.allowedGitHubOrganizations) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS);
      try {
        const response = await this.fetcher(
          `https://api.github.com/user/memberships/orgs/${encodeURIComponent(organization)}`,
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
              "User-Agent": "Open-Inspect-Control-Plane",
            },
            signal: controller.signal,
          }
        );
        if (response.status === 404) continue;
        if (!response.ok) {
          unavailable = true;
          continue;
        }
        const parsed = membershipSchema.safeParse(await response.json().catch(() => null));
        if (!parsed.success) {
          unavailable = true;
          continue;
        }
        if (parsed.data.state === "active") {
          return { reason: "github_organization", organization };
        }
      } catch {
        unavailable = true;
      } finally {
        clearTimeout(timer);
      }
    }

    if (unavailable) throw new AdmissionUnavailableError();
    throw new AdmissionDeniedError();
  }
}
