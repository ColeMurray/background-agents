import { describe, expect, it, vi } from "vitest";
import {
  SIGN_IN_PROVIDER_ISSUERS,
  type SignInProvider,
} from "@open-inspect/shared/sign-in-provider";
import { IdentityClaimStore } from "../../db/identity-claim-store";
import type { ProviderProfile } from "./provider-profile";
import { SignInClaim } from "./sign-in-claim";

function setup() {
  const store = new IdentityClaimStore({ prepare: vi.fn(), batch: vi.fn() });
  vi.spyOn(store, "findIdentityOwnerId").mockResolvedValue(null);
  vi.spyOn(store, "getEmailState").mockResolvedValue(null);
  vi.spyOn(store, "findEmailOwnerId").mockResolvedValue(null);
  vi.spyOn(store, "claimEmail").mockResolvedValue(true);
  vi.spyOn(store, "verifyEmail").mockResolvedValue(undefined);
  vi.spyOn(store, "normalizeStoredEmail").mockResolvedValue(undefined);
  vi.spyOn(store, "verifyEmailOwner").mockResolvedValue(null);
  return { claim: new SignInClaim(store), store: vi.mocked(store) };
}

function profile(
  provider: SignInProvider = "github",
  subject = `${provider}-subject`
): ProviderProfile {
  return {
    user: { email: " Person@Example.com ", emailVerified: true },
    data: {
      provider,
      issuer: SIGN_IN_PROVIDER_ISSUERS[provider],
      subject,
      verifiedEmails: ["person@example.com"],
      primaryEmail: "person@example.com",
    },
  };
}

describe("SignInClaim", () => {
  it.each(["github", "google"] as const)("claims the canonical %s identity", async (provider) => {
    const { claim, store } = setup();
    const resolvedProfile = profile(provider);
    Object.assign(resolvedProfile.user, { id: "mutable-user-id" });
    Object.assign(resolvedProfile.data, { id: "raw-id", sub: "raw-sub" });
    const tokens = { accessToken: "access-token" };
    const inner = vi.fn(async () => resolvedProfile);
    store.findIdentityOwnerId.mockResolvedValue("canonical-user");
    store.getEmailState.mockResolvedValue({ email: null, emailVerified: false });

    const result = await claim.wrapResolver(inner)(tokens);

    expect(result).toBe(resolvedProfile);
    expect(inner).toHaveBeenCalledWith(tokens);
    expect(store.findIdentityOwnerId).toHaveBeenCalledWith(provider, `${provider}-subject`);
    expect(store.claimEmail).toHaveBeenCalledWith("canonical-user", "person@example.com");
    expect(store.normalizeStoredEmail).not.toHaveBeenCalled();
  });

  it("skips claims without a subject", async () => {
    const { claim, store } = setup();
    const resolvedProfile = profile("github", "");
    Object.assign(resolvedProfile.user, { id: "mutable-user-id" });

    expect(await claim.wrapResolver(async () => resolvedProfile)({})).toBe(resolvedProfile);
    expect(store.findIdentityOwnerId).not.toHaveBeenCalled();
    expect(store.normalizeStoredEmail).not.toHaveBeenCalled();
    expect(store.verifyEmailOwner).not.toHaveBeenCalled();
  });

  it("skips claims without provider-verified email proof", async () => {
    const { claim, store } = setup();
    const resolvedProfile = {
      ...profile(),
      user: { email: "person@example.com", emailVerified: false },
    };

    expect(await claim.wrapResolver(async () => resolvedProfile)({})).toBe(resolvedProfile);
    expect(store.findIdentityOwnerId).not.toHaveBeenCalled();
    expect(store.verifyEmailOwner).not.toHaveBeenCalled();
  });

  it("normalizes and verifies an email owner when the subject is new", async () => {
    const { claim, store } = setup();
    const resolvedProfile = profile("google");

    await claim.wrapResolver(async () => resolvedProfile)({});

    expect(store.normalizeStoredEmail).toHaveBeenCalledWith("person@example.com");
    expect(store.verifyEmailOwner).toHaveBeenCalledWith("person@example.com");
    expect(store.normalizeStoredEmail.mock.invocationCallOrder[0]).toBeLessThan(
      store.verifyEmailOwner.mock.invocationCallOrder[0]
    );
  });

  it("does not claim an email owned by a different canonical user", async () => {
    const { claim, store } = setup();
    store.findIdentityOwnerId.mockResolvedValue("subject-owner");
    store.getEmailState.mockResolvedValue({ email: null, emailVerified: false });
    store.findEmailOwnerId.mockResolvedValue("email-owner");

    await claim.wrapResolver(async () => profile())({});

    expect(store.claimEmail).not.toHaveBeenCalled();
    expect(store.verifyEmail).not.toHaveBeenCalled();
    expect(store.verifyEmailOwner).not.toHaveBeenCalled();
  });

  it("returns the same profile when a claim fails", async () => {
    const { claim, store } = setup();
    const resolvedProfile = profile();
    store.findIdentityOwnerId.mockRejectedValue(new Error("database unavailable"));

    expect(await claim.wrapResolver(async () => resolvedProfile)({})).toBe(resolvedProfile);
    expect(store.normalizeStoredEmail).not.toHaveBeenCalled();
  });

  it("propagates admission failures without performing a claim", async () => {
    const { claim, store } = setup();
    const denied = new Error("admission denied");
    const inner = vi.fn().mockRejectedValue(denied);

    await expect(claim.wrapResolver(inner)({})).rejects.toBe(denied);
    expect(store.findIdentityOwnerId).not.toHaveBeenCalled();
    expect(store.verifyEmailOwner).not.toHaveBeenCalled();
  });

  it("preserves a null profile without performing a claim", async () => {
    const { claim, store } = setup();

    expect(await claim.wrapResolver(async () => null)({})).toBeNull();
    expect(store.findIdentityOwnerId).not.toHaveBeenCalled();
  });
});
