import { describe, expect, it } from "vitest";
import type { UserStore } from "../db/user-store";
import type { Env } from "../types";
import { parseAuthorId, resolveGitAuthorIdentity, resolveGitHubEnrichment } from "./identity";

describe("resolveGitAuthorIdentity", () => {
  it("derives a canonical noreply author from a trusted GitHub id and login", () => {
    expect(
      resolveGitAuthorIdentity({
        scmProvider: "github",
        scmUserId: "1001",
        scmLogin: "ada",
        scmName: "Ada Lovelace",
        scmEmail: "ada@private.example",
      })
    ).toEqual({
      name: "Ada Lovelace",
      email: "1001+ada@users.noreply.github.com",
    });
  });

  it("rejects a non-numeric GitHub user id", () => {
    expect(
      resolveGitAuthorIdentity({
        scmProvider: "github",
        scmUserId: "caller-supplied",
        scmLogin: "ada",
        scmName: "Ada Lovelace",
        scmEmail: "ada@example.com",
      })
    ).toBeNull();
  });

  it("rejects a value that is not a GitHub login", () => {
    expect(
      resolveGitAuthorIdentity({
        scmProvider: "github",
        scmUserId: "1001",
        scmLogin: "ada@example.com",
        scmName: "Ada Lovelace",
      })
    ).toBeNull();
  });

  it("preserves existing GitLab author metadata", () => {
    expect(
      resolveGitAuthorIdentity({
        scmProvider: "gitlab",
        scmUserId: "gitlab-user-1",
        scmLogin: "group-user",
        scmName: "Grace Hopper",
        scmEmail: "grace@gitlab.example",
      })
    ).toEqual({
      name: "Grace Hopper",
      email: "grace@gitlab.example",
    });
  });

  it("preserves GitLab's field-by-field fallback behavior", () => {
    expect(
      resolveGitAuthorIdentity({
        scmProvider: "gitlab",
        scmUserId: "gitlab-user-1",
        scmLogin: "group-user",
        scmName: "Grace Hopper",
        scmEmail: null,
      })
    ).toEqual({
      name: "Grace Hopper",
      email: "open-inspect@noreply.github.com",
    });
  });
});

describe("parseAuthorId", () => {
  it("parses github authorId", () => {
    expect(parseAuthorId("github:1001")).toEqual({
      provider: "github",
      providerUserId: "1001",
    });
  });

  it("parses slack authorId", () => {
    expect(parseAuthorId("slack:U123ABC")).toEqual({
      provider: "slack",
      providerUserId: "U123ABC",
    });
  });

  it("parses linear authorId", () => {
    expect(parseAuthorId("linear:abc-def")).toEqual({
      provider: "linear",
      providerUserId: "abc-def",
    });
  });

  it("returns null for plain user ID (web client)", () => {
    expect(parseAuthorId("user-id-123")).toBeNull();
  });

  it("returns null for 'anonymous'", () => {
    expect(parseAuthorId("anonymous")).toBeNull();
  });

  it("returns null for unknown provider prefix", () => {
    expect(parseAuthorId("unknown:12345")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseAuthorId("")).toBeNull();
  });
});

describe("resolveGitHubEnrichment", () => {
  // This is the fire-time F1/F2 gate: a resolved user with no linked GitHub
  // identity must yield null so no SCM token is attached (bot-attributed
  // fallback). With no TOKEN_ENCRYPTION_KEY the token-store branch is skipped,
  // so these unit tests need no D1 — they pin the identity-selection boundary.
  const env = { DB: {}, TOKEN_ENCRYPTION_KEY: "" } as unknown as Env;

  function fakeStore(
    identities: Array<{
      provider: string;
      providerUserId: string;
      providerEmail?: string | null;
      providerLogin?: string | null;
    }>,
    user?: { id: string; displayName?: string | null; email?: string | null }
  ): UserStore {
    return {
      getIdentitiesForUser: async () => identities,
      getUserById: async () => user ?? null,
    } as unknown as UserStore;
  }

  it("returns null for a pure-Google user — no linked GitHub identity means no SCM token", async () => {
    const store = fakeStore([
      { provider: "google", providerUserId: "google-sub-1", providerEmail: "pm@gmail.com" },
    ]);

    await expect(resolveGitHubEnrichment(env, env.DB, store, "user-1")).resolves.toBeNull();
  });

  it("enriches from the linked GitHub identity, never the Google one", async () => {
    const store = fakeStore(
      [
        { provider: "google", providerUserId: "google-sub-1", providerEmail: "pm@gmail.com" },
        {
          provider: "github",
          providerUserId: "gh-42",
          providerLogin: "pm-dev",
          providerEmail: "pm@users.noreply.github.com",
        },
      ],
      { id: "user-1", displayName: "PM Person", email: "pm@gmail.com" }
    );

    const enrichment = await resolveGitHubEnrichment(env, env.DB, store, "user-1");

    expect(enrichment).not.toBeNull();
    // The SCM identifier is the GitHub provider id — never the Google sub.
    expect(enrichment!.scmUserId).toBe("gh-42");
    expect(enrichment!.scmLogin).toBe("pm-dev");
    // No token-encryption key configured → no token material leaks in.
    expect(enrichment!.accessTokenEncrypted).toBeUndefined();
  });

  it("uses the canonical GitHub noreply address instead of a stored private email", async () => {
    const store = fakeStore(
      [
        {
          provider: "github",
          providerUserId: "42",
          providerLogin: "pm-dev",
          providerEmail: "private@example.com",
        },
      ],
      { id: "user-1", displayName: "PM Person" }
    );

    const enrichment = await resolveGitHubEnrichment(env, env.DB, store, "user-1");

    expect(enrichment?.email).toBe("42+pm-dev@users.noreply.github.com");
  });
});
