import { describe, expect, it } from "vitest";
import {
  buildAuthIdentity,
  buildScmCredentials,
  isAuthProvider,
  resolveAuthProvider,
  type AuthIdentityUser,
} from "./build-auth-identity";

const githubUser: AuthIdentityUser = {
  id: "12345",
  login: "ada",
  name: "Ada Lovelace",
  email: "ada@example.com",
  image: "https://avatars.githubusercontent.com/u/12345",
  provider: "github",
};

const googleUser: AuthIdentityUser = {
  id: "google-sub-1",
  name: "Pat PM",
  email: "pm@gmail.com",
  image: "https://lh3.googleusercontent.com/a/pat",
  provider: "google",
};

const tokens = {
  accessToken: "gho_abc",
  refreshToken: "ghr_def",
  accessTokenExpiresAt: 1_700_000_000_000,
};

describe("resolveAuthProvider", () => {
  it("returns the explicit provider", () => {
    expect(resolveAuthProvider(githubUser)).toBe("github");
    expect(resolveAuthProvider(googleUser)).toBe("google");
  });

  it("defaults a missing provider to github (legacy session back-compat)", () => {
    expect(resolveAuthProvider({ id: "12345" })).toBe("github");
    expect(resolveAuthProvider(null)).toBe("github");
    expect(resolveAuthProvider(undefined)).toBe("github");
  });
});

describe("isAuthProvider", () => {
  it("accepts supported providers", () => {
    expect(isAuthProvider("github")).toBe(true);
    expect(isAuthProvider("google")).toBe(true);
  });

  it("rejects unknown or missing providers", () => {
    expect(isAuthProvider("gitlab")).toBe(false);
    expect(isAuthProvider("")).toBe(false);
    expect(isAuthProvider(undefined)).toBe(false);
    expect(isAuthProvider(null)).toBe(false);
  });
});

describe("buildAuthIdentity", () => {
  it("maps a GitHub user to the auth* block", () => {
    expect(buildAuthIdentity(githubUser)).toEqual({
      authProvider: "github",
      authUserId: "12345",
      authEmail: "ada@example.com",
      authName: "Ada Lovelace",
      authAvatarUrl: "https://avatars.githubusercontent.com/u/12345",
    });
  });

  it("maps a Google user to the auth* block", () => {
    expect(buildAuthIdentity(googleUser)).toEqual({
      authProvider: "google",
      authUserId: "google-sub-1",
      authEmail: "pm@gmail.com",
      authName: "Pat PM",
      authAvatarUrl: "https://lh3.googleusercontent.com/a/pat",
    });
  });

  it("normalizes null fields to undefined and defaults the provider", () => {
    expect(buildAuthIdentity({ id: "12345", name: null, email: null, image: null })).toEqual({
      authProvider: "github",
      authUserId: "12345",
      authEmail: undefined,
      authName: undefined,
      authAvatarUrl: undefined,
    });
  });
});

describe("buildScmCredentials", () => {
  it("returns the full GitHub SCM block including the OAuth token", () => {
    expect(buildScmCredentials(githubUser, tokens)).toEqual({
      scmUserId: "12345",
      scmLogin: "ada",
      scmName: "Ada Lovelace",
      scmEmail: "ada@example.com",
      scmAvatarUrl: "https://avatars.githubusercontent.com/u/12345",
      scmToken: "gho_abc",
      scmRefreshToken: "ghr_def",
      scmTokenExpiresAt: 1_700_000_000_000,
    });
  });

  it("returns an empty object for Google — no scm* fields, and no token leak even if one is passed", () => {
    // The credential-leak gate (F1/F2): a Google session must never carry an
    // SCM token, regardless of what the JWT holds.
    expect(buildScmCredentials(googleUser, { accessToken: "ya29.google-token" })).toEqual({});
  });

  it("treats a missing provider as GitHub (legacy session back-compat)", () => {
    expect(buildScmCredentials({ id: "12345", login: "ada" }, tokens)).toMatchObject({
      scmUserId: "12345",
      scmLogin: "ada",
      scmToken: "gho_abc",
    });
  });

  it("tolerates absent tokens", () => {
    expect(buildScmCredentials(githubUser, null)).toMatchObject({
      scmUserId: "12345",
      scmToken: undefined,
      scmRefreshToken: undefined,
      scmTokenExpiresAt: undefined,
    });
  });
});
