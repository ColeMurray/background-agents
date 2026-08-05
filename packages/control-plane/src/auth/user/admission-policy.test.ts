import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AdmissionDeniedError,
  AdmissionPolicy,
  AdmissionUnavailableError,
  parseAdmissionAllowlist,
  parseAdmissionBoolean,
  type AdmissionPolicyConfig,
  type GitHubAdmissionEvidence,
  type GoogleAdmissionEvidence,
} from "./admission-policy";

const BASE_CONFIG: AdmissionPolicyConfig = {
  allowedGitHubUsers: [],
  allowedEmails: [],
  allowedEmailDomains: [],
  allowedGitHubOrganizations: [],
  unsafeAllowAllUsers: false,
};

const GOOGLE_SIGN_IN: GoogleAdmissionEvidence = {
  identity: {
    provider: "google",
    issuer: "https://accounts.google.com",
    subject: "google-subject",
    verifiedEmails: ["first@example.net", "allowed@corp.example"],
    primaryEmail: "first@example.net",
  },
};

const GITHUB_SIGN_IN: GitHubAdmissionEvidence = {
  identity: {
    provider: "github",
    issuer: "https://github.com",
    subject: "123",
    login: "octocat",
    verifiedEmails: [],
    primaryEmail: null,
  },
  accessToken: "ghu_token",
};

describe("AdmissionPolicy", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("evaluates the complete verified email set with OR semantics", async () => {
    const policy = new AdmissionPolicy({
      ...BASE_CONFIG,
      allowedEmailDomains: ["corp.example"],
    });

    await expect(policy.requireAdmission(GOOGLE_SIGN_IN)).resolves.toEqual({
      reason: "email_domain_allowlist",
    });
  });

  it("admits an active GitHub organization member with the current access token", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ state: "active" }));
    const policy = new AdmissionPolicy(
      {
        ...BASE_CONFIG,
        allowedGitHubOrganizations: ["open-inspect"],
      },
      { fetcher }
    );

    await expect(policy.requireAdmission(GITHUB_SIGN_IN)).resolves.toEqual({
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

  it("preserves the Worker receiver when using the default global fetch", async () => {
    const runtimeFetch = vi.fn(function (this: unknown) {
      if (this !== globalThis) {
        throw new TypeError("Illegal invocation");
      }
      return Promise.resolve(Response.json({ state: "active" }));
    });
    vi.stubGlobal("fetch", runtimeFetch);
    const policy = new AdmissionPolicy({
      ...BASE_CONFIG,
      allowedGitHubOrganizations: ["open-inspect"],
    });

    await expect(policy.requireAdmission(GITHUB_SIGN_IN)).resolves.toEqual({
      reason: "github_organization",
      organization: "open-inspect",
    });
    expect(runtimeFetch).toHaveBeenCalledOnce();
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
    const unavailable = new AdmissionPolicy(
      {
        ...BASE_CONFIG,
        allowedGitHubOrganizations: ["open-inspect"],
      },
      {
        fetcher: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 })),
      }
    );
    await expect(unavailable.requireAdmission(GITHUB_SIGN_IN)).rejects.toBeInstanceOf(
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
    await expect(denied.requireAdmission(GITHUB_SIGN_IN)).rejects.toBeInstanceOf(
      AdmissionDeniedError
    );

    const pending = new AdmissionPolicy(
      {
        ...BASE_CONFIG,
        allowedGitHubOrganizations: ["open-inspect"],
      },
      {
        fetcher: vi.fn<typeof fetch>().mockResolvedValue(Response.json({ state: "pending" })),
      }
    );
    await expect(pending.requireAdmission(GITHUB_SIGN_IN)).rejects.toBeInstanceOf(
      AdmissionDeniedError
    );
  });
});
