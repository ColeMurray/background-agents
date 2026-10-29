import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AdmissionDeniedError,
  AdmissionPolicy,
  AdmissionUnavailableError,
  GITHUB_ORGANIZATION_CONCURRENCY,
  GITHUB_ORGANIZATION_EVALUATION_TIMEOUT_MS,
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
    vi.useRealTimers();
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

  it.each([
    { allowedGitHubUsers: ["octocat"] },
    { allowedEmails: ["allowed@corp.example"] },
    { allowedEmailDomains: ["corp.example"] },
  ])("skips all organization requests after a local match: %j", async (rules) => {
    const fetcher = vi.fn<typeof fetch>();
    const policy = new AdmissionPolicy(
      { ...BASE_CONFIG, ...rules, allowedGitHubOrganizations: ["slow-org"] },
      { fetcher }
    );
    await expect(
      policy.requireAdmission({
        ...GITHUB_SIGN_IN,
        identity: { ...GITHUB_SIGN_IN.identity, verifiedEmails: ["allowed@corp.example"] },
      })
    ).resolves.toBeDefined();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("admits a later active organization without waiting for the first and cancels outstanding requests", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const signal = init!.signal!;
      signals.push(signal);
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        if (String(input).endsWith("/active")) {
          setTimeout(() => resolve(Response.json({ state: "active" })), 25);
        }
      });
    });
    const policy = new AdmissionPolicy(
      { ...BASE_CONFIG, allowedGitHubOrganizations: ["slow", "active", "also-slow"] },
      { fetcher }
    );
    const admitted = expect(policy.requireAdmission(GITHUB_SIGN_IN)).resolves.toEqual({
      reason: "github_organization",
      organization: "active",
    });
    await vi.advanceTimersByTimeAsync(24);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await admitted;
    expect(signals).toHaveLength(3);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds legacy organization fan-out and fails unavailable at the exact total deadline", async () => {
    vi.useFakeTimers();
    // Even a fetch implementation that ignores abort cannot hold the evaluation open.
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
    const policy = new AdmissionPolicy(
      {
        ...BASE_CONFIG,
        allowedGitHubOrganizations: Array.from({ length: 100 }, (_, i) => `org-${i}`),
      },
      { fetcher }
    );
    let settled = false;
    const result = policy.requireAdmission(GITHUB_SIGN_IN);
    void result.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    const rejected = expect(result).rejects.toBeInstanceOf(AdmissionUnavailableError);
    expect(fetcher).toHaveBeenCalledTimes(GITHUB_ORGANIZATION_CONCURRENCY);
    await vi.advanceTimersByTimeAsync(GITHUB_ORGANIZATION_EVALUATION_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(fetcher).toHaveBeenCalledTimes(GITHUB_ORGANIZATION_CONCURRENCY);
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not restart the deadline when a worker advances to a queued organization", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      (_input, init) =>
        new Promise((resolve, reject) => {
          init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), {
            once: true,
          });
          if (fetcher.mock.calls.length === 1) {
            setTimeout(
              () => resolve(Response.json({ state: "pending" })),
              GITHUB_ORGANIZATION_EVALUATION_TIMEOUT_MS - 1
            );
          }
        })
    );
    const policy = new AdmissionPolicy(
      {
        ...BASE_CONFIG,
        allowedGitHubOrganizations: Array.from(
          { length: GITHUB_ORGANIZATION_CONCURRENCY + 1 },
          (_, i) => `org-${i}`
        ),
      },
      { fetcher }
    );
    const rejected = expect(policy.requireAdmission(GITHUB_SIGN_IN)).rejects.toBeInstanceOf(
      AdmissionUnavailableError
    );
    await vi.advanceTimersByTimeAsync(GITHUB_ORGANIZATION_EVALUATION_TIMEOUT_MS - 1);
    expect(fetcher).toHaveBeenCalledTimes(GITHUB_ORGANIZATION_CONCURRENCY + 1);
    expect(fetcher.mock.calls.at(-1)?.[1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it("keeps processing queued organizations while an earlier request is stalled", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/org-0")) return new Promise(() => {});
      return Response.json({ state: url.endsWith("/active") ? "active" : "pending" });
    });
    const policy = new AdmissionPolicy(
      {
        ...BASE_CONFIG,
        allowedGitHubOrganizations: [
          ...Array.from({ length: GITHUB_ORGANIZATION_CONCURRENCY }, (_, i) => `org-${i}`),
          "active",
        ],
      },
      { fetcher }
    );
    await expect(policy.requireAdmission(GITHUB_SIGN_IN)).resolves.toEqual({
      reason: "github_organization",
      organization: "active",
    });
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it.each([404, 503])(
    "releases streaming %s bodies before starting queued checks",
    async (status) => {
      const cancel = vi.fn();
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
        if (String(input).endsWith("/active")) {
          expect(cancel).toHaveBeenCalled();
          return Response.json({ state: "active" });
        }
        return new Response(new ReadableStream({ cancel }), { status });
      });
      const policy = new AdmissionPolicy(
        {
          ...BASE_CONFIG,
          allowedGitHubOrganizations: ["first", "second", "third", "fourth", "active"],
        },
        { fetcher }
      );
      await expect(policy.requireAdmission(GITHUB_SIGN_IN)).resolves.toEqual({
        reason: "github_organization",
        organization: "active",
      });
      expect(cancel).toHaveBeenCalledTimes(4);
    }
  );

  it.each(["pending", "active"] as const)(
    "keeps provider failure distinct from denial, unless another check is %s",
    async (state) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockRejectedValueOnce(new Error("network failure"))
        .mockResolvedValueOnce(Response.json({ state }));
      const policy = new AdmissionPolicy(
        { ...BASE_CONFIG, allowedGitHubOrganizations: ["unavailable", "other"] },
        { fetcher }
      );
      const result = policy.requireAdmission(GITHUB_SIGN_IN);
      if (state === "active") {
        await expect(result).resolves.toEqual({
          reason: "github_organization",
          organization: "other",
        });
      } else {
        await expect(result).rejects.toBeInstanceOf(AdmissionUnavailableError);
      }
    }
  );

  it.each([{ state: "unknown" }, {}, null])(
    "treats malformed membership evidence as unavailable: %j",
    async (body) => {
      const policy = new AdmissionPolicy(
        { ...BASE_CONFIG, allowedGitHubOrganizations: ["malformed"] },
        { fetcher: vi.fn<typeof fetch>().mockResolvedValue(Response.json(body)) }
      );
      await expect(policy.requireAdmission(GITHUB_SIGN_IN)).rejects.toBeInstanceOf(
        AdmissionUnavailableError
      );
    }
  );

  it("includes a stalled response body in the total deadline and cancels its read", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      async (_input, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              init!.signal!.addEventListener(
                "abort",
                () => controller.error(init!.signal!.reason),
                { once: true }
              );
            },
          })
        )
    );
    const policy = new AdmissionPolicy(
      { ...BASE_CONFIG, allowedGitHubOrganizations: ["stalled-body"] },
      { fetcher }
    );
    const rejected = expect(policy.requireAdmission(GITHUB_SIGN_IN)).rejects.toBeInstanceOf(
      AdmissionUnavailableError
    );
    await vi.advanceTimersByTimeAsync(GITHUB_ORGANIZATION_EVALUATION_TIMEOUT_MS);
    await rejected;
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
