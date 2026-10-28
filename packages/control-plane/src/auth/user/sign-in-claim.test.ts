import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { IdentityClaimStore } from "../../db/identity-claim-store";
import type { ProviderProfile, ProviderProfileResolver } from "./provider-profile";
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

function profile<Data>(data: Data): ProviderProfile<Data> {
  return { user: { email: " Person@Example.com ", emailVerified: true }, data };
}

describe("SignInClaim", () => {
  it.each([
    { provider: "github" as const, data: { id: "github-subject", sub: "wrong-subject" } },
    { provider: "google" as const, data: { sub: "google-subject", id: "wrong-subject" } },
  ])("claims the $provider subject from verified profile data", async ({ provider, data }) => {
    const { claim, store } = setup();
    const resolvedProfile = profile(data);
    Object.assign(resolvedProfile.user, { id: "mutable-user-id" });
    const tokens = { accessToken: "access-token" };
    const inner = vi.fn(async () => resolvedProfile);
    store.findIdentityOwnerId.mockResolvedValue("canonical-user");
    store.getEmailState.mockResolvedValue({ email: null, emailVerified: false });

    const result = await claim.wrapResolver(provider, inner)(tokens);

    expect(result).toBe(resolvedProfile);
    expect(inner).toHaveBeenCalledWith(tokens);
    expect(store.findIdentityOwnerId).toHaveBeenCalledWith(provider, `${provider}-subject`);
    expect(store.claimEmail).toHaveBeenCalledWith("canonical-user", "person@example.com");
    expect(store.normalizeStoredEmail).not.toHaveBeenCalled();
  });

  it("preserves provider-specific data typing through the decorator", () => {
    const { claim } = setup();
    const inner = async () => profile({ id: "583231", login: "octocat" });

    expectTypeOf(claim.wrapResolver("github", inner)).toEqualTypeOf<
      ProviderProfileResolver<{ id: string; login: string }>
    >();
  });

  it.each([
    { provider: "github" as const, data: { sub: "wrong-provider-subject" } },
    { provider: "google" as const, data: { id: "wrong-provider-subject" } },
    { provider: "github" as const, data: { id: " " } },
    { provider: "google" as const, data: { sub: null } },
    { provider: "github" as const, data: null },
  ])("skips claims without a valid $provider raw subject: $data", async ({ provider, data }) => {
    const { claim, store } = setup();
    const resolvedProfile = profile(data);
    Object.assign(resolvedProfile.user, { id: "mutable-user-id" });

    expect(await claim.wrapResolver(provider, async () => resolvedProfile)({})).toBe(
      resolvedProfile
    );
    expect(store.findIdentityOwnerId).not.toHaveBeenCalled();
    expect(store.normalizeStoredEmail).not.toHaveBeenCalled();
    expect(store.verifyEmailOwner).not.toHaveBeenCalled();
  });

  it("skips claims without provider-verified email proof", async () => {
    const { claim, store } = setup();
    const resolvedProfile = {
      ...profile({ id: "github-subject" }),
      user: { email: "person@example.com", emailVerified: false },
    };

    expect(await claim.wrapResolver("github", async () => resolvedProfile)({})).toBe(
      resolvedProfile
    );
    expect(store.findIdentityOwnerId).not.toHaveBeenCalled();
    expect(store.verifyEmailOwner).not.toHaveBeenCalled();
  });

  it("normalizes and verifies an email owner when the raw subject is new", async () => {
    const { claim, store } = setup();
    const resolvedProfile = profile({ sub: "google-subject" });

    await claim.wrapResolver("google", async () => resolvedProfile)({});

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

    await claim.wrapResolver("github", async () => profile({ id: "github-subject" }))({});

    expect(store.claimEmail).not.toHaveBeenCalled();
    expect(store.verifyEmail).not.toHaveBeenCalled();
    expect(store.verifyEmailOwner).not.toHaveBeenCalled();
  });

  it("returns the same profile when a claim fails", async () => {
    const { claim, store } = setup();
    const resolvedProfile = profile({ id: "github-subject" });
    store.findIdentityOwnerId.mockRejectedValue(new Error("database unavailable"));

    expect(await claim.wrapResolver("github", async () => resolvedProfile)({})).toBe(
      resolvedProfile
    );
    expect(store.normalizeStoredEmail).not.toHaveBeenCalled();
  });

  it("propagates admission failures without performing a claim", async () => {
    const { claim, store } = setup();
    const denied = new Error("admission denied");
    const inner = vi.fn().mockRejectedValue(denied);

    await expect(claim.wrapResolver("github", inner)({})).rejects.toBe(denied);
    expect(store.findIdentityOwnerId).not.toHaveBeenCalled();
    expect(store.verifyEmailOwner).not.toHaveBeenCalled();
  });

  it("preserves a null profile without performing a claim", async () => {
    const { claim, store } = setup();

    expect(await claim.wrapResolver("github", async () => null)({})).toBeNull();
    expect(store.findIdentityOwnerId).not.toHaveBeenCalled();
  });
});
