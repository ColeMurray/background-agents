import { describe, expect, it, vi } from "vitest";
import {
  AdmissionDeniedError,
  AdmissionPolicy,
  AdmissionUnavailableError,
  parseAdmissionAllowlist,
  parseAdmissionBoolean,
  type AdmissionPolicyConfig,
} from "./admission-policy";
import type { ProviderCodeExchangeResult } from "./providers/types";

const BASE_CONFIG: AdmissionPolicyConfig = {
  allowedGitHubUsers: [],
  allowedEmails: [],
  allowedEmailDomains: [],
  allowedGitHubOrganizations: [],
  unsafeAllowAllUsers: false,
};

const GOOGLE_SIGN_IN: ProviderCodeExchangeResult<"google"> = {
  identity: {
    provider: "google",
    issuer: "https://accounts.google.com",
    subject: "google-subject",
    verifiedEmails: ["first@example.net", "allowed@corp.example"],
    primaryEmail: "first@example.net",
  },
  credential: null,
};

describe("AdmissionPolicy", () => {
  it("evaluates the complete verified email set with OR semantics", async () => {
    const policy = new AdmissionPolicy({
      ...BASE_CONFIG,
      allowedEmailDomains: ["corp.example"],
    });

    await expect(policy.requireAdmission(GOOGLE_SIGN_IN)).resolves.toEqual({
      reason: "email_domain_allowlist",
    });
  });

  it("admits an active GitHub organization member with the current flow credential", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ state: "active" }));
    const policy = new AdmissionPolicy(
      {
        ...BASE_CONFIG,
        allowedGitHubOrganizations: ["open-inspect"],
      },
      { fetcher }
    );

    await expect(
      policy.requireAdmission({
        identity: {
          provider: "github",
          issuer: "https://github.com",
          subject: "123",
          login: "octocat",
          verifiedEmails: [],
          primaryEmail: null,
        },
        credential: {
          kind: "access_only_nonexpiring",
          accessToken: "ghu_token",
        },
      })
    ).resolves.toEqual({
      reason: "github_organization",
      organization: "open-inspect",
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.github.com/user/memberships/orgs/open-inspect",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer ghu_token" }),
        signal: expect.any(AbortSignal),
      })
    );
  });

  it("parses deployment admission settings conservatively", () => {
    expect(parseAdmissionAllowlist(" Alice,alice, BOB ,, ")).toEqual(["alice", "bob"]);
    expect(parseAdmissionBoolean(" TRUE ")).toBe(true);
    expect(parseAdmissionBoolean("1")).toBe(false);
    expect(parseAdmissionBoolean(undefined)).toBe(false);
  });

  it("keeps unsafe allow-all limited to an otherwise empty policy", async () => {
    const emptyPolicy = new AdmissionPolicy({
      ...BASE_CONFIG,
      unsafeAllowAllUsers: true,
    });
    await expect(emptyPolicy.requireAdmission(GOOGLE_SIGN_IN)).resolves.toEqual({
      reason: "unsafe_allow_all",
    });

    const configuredPolicy = new AdmissionPolicy({
      ...BASE_CONFIG,
      allowedEmails: ["someone@example.com"],
      unsafeAllowAllUsers: true,
    });
    await expect(configuredPolicy.requireAdmission(GOOGLE_SIGN_IN)).rejects.toBeInstanceOf(
      AdmissionDeniedError
    );
  });

  it("does not apply the GitHub username allowlist to another provider", async () => {
    const policy = new AdmissionPolicy({
      ...BASE_CONFIG,
      allowedGitHubUsers: ["google-subject"],
    });

    await expect(policy.requireAdmission(GOOGLE_SIGN_IN)).rejects.toBeInstanceOf(
      AdmissionDeniedError
    );
  });

  it("distinguishes definitive non-membership from an unavailable organization check", async () => {
    const signIn: ProviderCodeExchangeResult<"github"> = {
      identity: {
        provider: "github",
        issuer: "https://github.com",
        subject: "123",
        verifiedEmails: [],
        primaryEmail: null,
      },
      credential: {
        kind: "access_only_nonexpiring",
        accessToken: "ghu_token",
      },
    };
    const unavailable = new AdmissionPolicy(
      {
        ...BASE_CONFIG,
        allowedGitHubOrganizations: ["open-inspect"],
      },
      {
        fetcher: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 })),
      }
    );
    await expect(unavailable.requireAdmission(signIn)).rejects.toBeInstanceOf(
      AdmissionUnavailableError
    );

    const denied = new AdmissionPolicy(
      {
        ...BASE_CONFIG,
        allowedGitHubOrganizations: ["open-inspect"],
      },
      {
        fetcher: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 })),
      }
    );
    await expect(denied.requireAdmission(signIn)).rejects.toBeInstanceOf(AdmissionDeniedError);

    const pending = new AdmissionPolicy(
      {
        ...BASE_CONFIG,
        allowedGitHubOrganizations: ["open-inspect"],
      },
      {
        fetcher: vi.fn<typeof fetch>().mockResolvedValue(Response.json({ state: "pending" })),
      }
    );
    await expect(pending.requireAdmission(signIn)).rejects.toBeInstanceOf(AdmissionDeniedError);
  });
});
