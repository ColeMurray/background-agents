import { describe, expect, it } from "vitest";
import type { UserStore } from "../db/user-store";
import type { Env } from "../types";
import {
  deriveParticipantUserId,
  parseAuthorId,
  resolveGitAuthorIdentity,
  resolveGitHubEnrichment,
  resolveProviderIdentity,
} from "./identity";

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

describe("deriveParticipantUserId", () => {
  it("returns explicit userId for non-bot spawnSource", () => {
    expect(deriveParticipantUserId({ userId: "user-abc", spawnSource: "user" })).toBe("user-abc");
  });

  it("ignores explicit userId for bot spawnSource and derives from identity fields", () => {
    expect(
      deriveParticipantUserId({
        userId: "user-abc",
        spawnSource: "github-bot",
        scmUserId: "1001",
      })
    ).toBe("github:1001");
  });

  it("derives github-bot userId from scmUserId", () => {
    expect(deriveParticipantUserId({ spawnSource: "github-bot", scmUserId: "1001" })).toBe(
      "github:1001"
    );
  });

  it("derives slack-bot userId from actorUserId", () => {
    expect(deriveParticipantUserId({ spawnSource: "slack-bot", actorUserId: "U123" })).toBe(
      "slack:U123"
    );
  });

  it("derives linear-bot userId from actorUserId", () => {
    expect(deriveParticipantUserId({ spawnSource: "linear-bot", actorUserId: "lin-abc" })).toBe(
      "linear:lin-abc"
    );
  });

  it("falls back to anonymous for github-bot without scmUserId", () => {
    expect(deriveParticipantUserId({ spawnSource: "github-bot" })).toBe("anonymous");
  });

  it("falls back to anonymous for slack-bot without actorUserId", () => {
    expect(deriveParticipantUserId({ spawnSource: "slack-bot" })).toBe("anonymous");
  });

  it("falls back to anonymous for linear-bot without actorUserId", () => {
    expect(deriveParticipantUserId({ spawnSource: "linear-bot" })).toBe("anonymous");
  });

  it("falls back to anonymous for unknown spawnSource", () => {
    expect(deriveParticipantUserId({ spawnSource: "user" })).toBe("anonymous");
  });

  it("falls back to anonymous when no fields provided", () => {
    expect(deriveParticipantUserId({})).toBe("anonymous");
  });
});

describe("resolveProviderIdentity", () => {
  // Characterization tests: lock in the current output for every branch before
  // the user/github-bot case is split and the auth* block is introduced.
  describe("current behavior", () => {
    it("maps a web user (spawnSource 'user') to a github identity from scm* fields", () => {
      expect(
        resolveProviderIdentity("user", {
          spawnSource: "user",
          scmUserId: "1001",
          scmLogin: "ada",
          scmName: "Ada Lovelace",
          scmEmail: "ada@example.com",
          scmAvatarUrl: "https://avatars.githubusercontent.com/u/1001",
        })
      ).toEqual({
        provider: "github",
        providerUserId: "1001",
        providerLogin: "ada",
        providerEmail: "ada@example.com",
        displayName: "Ada Lovelace",
        avatarUrl: "https://avatars.githubusercontent.com/u/1001",
      });
    });

    it("falls back to scmLogin for displayName when scmName is absent (user)", () => {
      expect(
        resolveProviderIdentity("user", { spawnSource: "user", scmUserId: "1001", scmLogin: "ada" })
      ).toEqual({
        provider: "github",
        providerUserId: "1001",
        providerLogin: "ada",
        providerEmail: undefined,
        displayName: "ada",
        avatarUrl: undefined,
      });
    });

    it("returns null for a web user without scmUserId", () => {
      expect(resolveProviderIdentity("user", { spawnSource: "user" })).toBeNull();
    });

    it("maps github-bot to a github identity from scm* fields", () => {
      expect(
        resolveProviderIdentity("github-bot", {
          spawnSource: "github-bot",
          scmUserId: "2002",
          scmLogin: "octocat",
          scmName: "Octo Cat",
          scmEmail: "octo@example.com",
          scmAvatarUrl: "https://avatars.githubusercontent.com/u/2002",
        })
      ).toEqual({
        provider: "github",
        providerUserId: "2002",
        providerLogin: "octocat",
        providerEmail: "octo@example.com",
        displayName: "Octo Cat",
        avatarUrl: "https://avatars.githubusercontent.com/u/2002",
      });
    });

    it("returns null for github-bot without scmUserId", () => {
      expect(resolveProviderIdentity("github-bot", { spawnSource: "github-bot" })).toBeNull();
    });

    it("maps slack-bot to a slack identity from actor* fields", () => {
      expect(
        resolveProviderIdentity("slack-bot", {
          spawnSource: "slack-bot",
          actorUserId: "U123",
          actorEmail: "slacker@example.com",
          actorDisplayName: "Slacker",
          actorAvatarUrl: "https://slack.example/avatar",
        })
      ).toEqual({
        provider: "slack",
        providerUserId: "U123",
        providerEmail: "slacker@example.com",
        displayName: "Slacker",
        avatarUrl: "https://slack.example/avatar",
      });
    });

    it("returns null for slack-bot without actorUserId", () => {
      expect(resolveProviderIdentity("slack-bot", { spawnSource: "slack-bot" })).toBeNull();
    });

    it("maps linear-bot to a linear identity from actor* fields (no avatar)", () => {
      expect(
        resolveProviderIdentity("linear-bot", {
          spawnSource: "linear-bot",
          actorUserId: "lin-1",
          actorEmail: "lin@example.com",
          actorDisplayName: "Lin",
        })
      ).toEqual({
        provider: "linear",
        providerUserId: "lin-1",
        providerEmail: "lin@example.com",
        displayName: "Lin",
      });
    });

    it("returns null for linear-bot without actorUserId", () => {
      expect(resolveProviderIdentity("linear-bot", { spawnSource: "linear-bot" })).toBeNull();
    });

    it("returns null for an unknown spawnSource", () => {
      expect(
        resolveProviderIdentity("automation", { spawnSource: "automation", scmUserId: "9" })
      ).toBeNull();
    });
  });

  describe("google + back-compat (post-split)", () => {
    it("maps a Google web user to a google identity from auth* fields (no scm*)", () => {
      expect(
        resolveProviderIdentity("user", {
          spawnSource: "user",
          authProvider: "google",
          authUserId: "google-sub-123",
          authEmail: "pm@corp.com",
          authName: "PM Person",
          authAvatarUrl: "https://lh3.googleusercontent.com/pic",
        })
      ).toEqual({
        provider: "google",
        providerUserId: "google-sub-123",
        providerLogin: undefined,
        providerEmail: "pm@corp.com",
        displayName: "PM Person",
        avatarUrl: "https://lh3.googleusercontent.com/pic",
      });
    });

    it("still resolves an old-web scm-only payload (no auth*) to a github identity (M2/R1 back-compat)", () => {
      // During the staggered web/control-plane rollout, old web keeps sending
      // scm* with no auth*. Without the fallback this would resolve to NULL and
      // every in-flight GitHub user's session would lose its user_id.
      expect(
        resolveProviderIdentity("user", {
          spawnSource: "user",
          scmUserId: "1001",
          scmLogin: "ada",
          scmName: "Ada Lovelace",
          scmEmail: "ada@example.com",
          scmAvatarUrl: "https://avatars.githubusercontent.com/u/1001",
        })
      ).toEqual({
        provider: "github",
        providerUserId: "1001",
        providerLogin: "ada",
        providerEmail: "ada@example.com",
        displayName: "Ada Lovelace",
        avatarUrl: "https://avatars.githubusercontent.com/u/1001",
      });
    });

    it("prefers auth* over scm* when the GitHub web path sends both (providerLogin stays scm-sourced)", () => {
      expect(
        resolveProviderIdentity("user", {
          spawnSource: "user",
          authProvider: "github",
          authUserId: "1001",
          authEmail: "ada@auth.example.com",
          authName: "Ada (auth)",
          authAvatarUrl: "https://auth.example/pic",
          scmUserId: "1001",
          scmLogin: "ada",
          scmName: "Ada (scm)",
          scmEmail: "ada@scm.example.com",
          scmAvatarUrl: "https://scm.example/pic",
        })
      ).toEqual({
        provider: "github",
        providerUserId: "1001",
        providerLogin: "ada",
        providerEmail: "ada@auth.example.com",
        displayName: "Ada (auth)",
        avatarUrl: "https://auth.example/pic",
      });
    });

    it("returns null for a Google web user missing authUserId (and no scm fallback)", () => {
      expect(
        resolveProviderIdentity("user", { spawnSource: "user", authProvider: "google" })
      ).toBeNull();
    });

    it("fails closed on an unsupported authProvider rather than persisting it raw", () => {
      expect(
        resolveProviderIdentity("user", {
          spawnSource: "user",
          // Deliberately invalid discriminator from a malformed/crafted body.
          authProvider: "evil" as unknown as "github" | "google",
          authUserId: "x-1",
          scmUserId: "1001",
        })
      ).toBeNull();
    });

    it("never pairs authProvider with a scm* fallback id (no mixed-source identity)", () => {
      // authUserId absent: identity comes entirely from scm* (always github),
      // never provider=authProvider paired with providerUserId=scmUserId.
      expect(
        resolveProviderIdentity("user", {
          spawnSource: "user",
          authProvider: "google",
          scmUserId: "1001",
          scmLogin: "ada",
        })
      ).toEqual({
        provider: "github",
        providerUserId: "1001",
        providerLogin: "ada",
        providerEmail: undefined,
        displayName: "ada",
        avatarUrl: undefined,
      });
    });
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
