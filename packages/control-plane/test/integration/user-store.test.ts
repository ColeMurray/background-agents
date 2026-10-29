import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { TeamMembershipStore } from "../../src/db/team-memberships";
import { TeamStore } from "../../src/db/teams";
import { UserStore, type ProviderIdentity } from "../../src/db/user-store";
import { cleanD1Tables } from "./cleanup";
import { sqlDatabase } from "./helpers";

const providerIssuers = [
  ["github", "https://github.com"],
  ["google", "https://accounts.google.com"],
  ["slack", null],
  ["linear", null],
] as const;

describe("UserStore", () => {
  let store: UserStore;

  function enrollFixtureUser(identity: ProviderIdentity) {
    return store.resolveOrCreateUser(identity, () => {});
  }

  beforeEach(async () => {
    await cleanD1Tables();
    store = new UserStore(env.DB);
  });

  describe("listCollaboratorCandidates", () => {
    it("returns an empty list when there are no active users", async () => {
      expect(await store.listCollaboratorCandidates({ includeEmail: true })).toEqual([]);
    });

    it("returns only active picker identities ordered by name with email fallback", async () => {
      const zed = await store.createUser({ displayName: "zed" });
      const alice = await store.createUser({
        displayName: "ALICE",
        avatarUrl: "https://example.com/alice.png",
      });
      const bob = await store.createUser({ email: "bob@example.com" });
      const suspended = await store.createUser({ displayName: "Suspended" });
      const unassigned = await store.createUser({ displayName: "Unassigned" });
      await env.DB.batch([
        env.DB.prepare("UPDATE users SET suspended_at = 1 WHERE id = ?").bind(suspended.id),
        env.DB.prepare("DELETE FROM user_role_assignments WHERE user_id = ?").bind(unassigned.id),
      ]);

      expect(await store.listCollaboratorCandidates({ includeEmail: true })).toEqual([
        {
          userId: alice.id,
          displayName: "ALICE",
          email: null,
          avatarUrl: "https://example.com/alice.png",
        },
        { userId: bob.id, displayName: null, email: "bob@example.com", avatarUrl: null },
        { userId: zed.id, displayName: "zed", email: null, avatarUrl: null },
      ]);
    });

    it("does not read or sort by email when email is excluded", async () => {
      const user = await store.createUser({ email: "private@example.com" });
      const db = sqlDatabase(env.DB);
      const prepare = vi.fn((sql: string) => db.prepare(sql));
      const candidates = await new UserStore({
        prepare,
        batch: db.batch.bind(db),
      }).listCollaboratorCandidates({ includeEmail: false });
      expect(candidates).toEqual([
        { userId: user.id, displayName: null, email: null, avatarUrl: null },
      ]);
      expect(prepare).toHaveBeenCalledWith(expect.stringContaining("NULL AS email"));
      expect(prepare.mock.calls[0][0]).not.toContain("users.email");
    });
  });

  describe("getCollaboratorEligibility", () => {
    it("requires an active user and, for a team, current membership", async () => {
      const member = await store.createUser({ displayName: "Member" });
      const outsider = await store.createUser({ displayName: "Outsider" });
      const suspended = await store.createUser({ displayName: "Suspended" });
      const unassigned = await store.createUser({ displayName: "Unassigned" });
      const team = await new TeamStore(env.DB).create({
        slug: "eligibility",
        name: "Eligibility",
        joinPolicy: "invite_only",
      });
      await new TeamMembershipStore(env.DB).add(team.id, member.id);
      await env.DB.batch([
        env.DB.prepare("UPDATE users SET suspended_at = 1 WHERE id = ?").bind(suspended.id),
        env.DB.prepare("DELETE FROM user_role_assignments WHERE user_id = ?").bind(unassigned.id),
      ]);

      expect(await store.getCollaboratorEligibility("missing", null)).toBe("not_found");
      expect(await store.getCollaboratorEligibility(suspended.id, null)).toBe("inactive");
      expect(await store.getCollaboratorEligibility(unassigned.id, null)).toBe("inactive");
      expect(await store.getCollaboratorEligibility(outsider.id, null)).toBe("eligible");
      expect(await store.getCollaboratorEligibility(outsider.id, team.id)).toBe("not_team_member");
      expect(await store.getCollaboratorEligibility(member.id, team.id)).toBe("eligible");
    });
  });

  // ── resolveOrCreateUser ─────────────────────────────────────────

  describe("resolveOrCreateUser", () => {
    it("requires admission explicitly and fails closed if it is omitted at runtime", async () => {
      // @ts-expect-error Enrollment admission is required even for fixture creation.
      const enrollment = store.resolveOrCreateUser({
        provider: "slack",
        providerUserId: "missing-policy",
      });
      await expect(enrollment).rejects.toThrow();

      for (const table of ["users", "user_identities", "user_role_assignments"]) {
        expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first()).toEqual({
          count: 0,
        });
      }
    });

    it("checks each operation's normalized identity before creating a user", async () => {
      const requireAdmission = vi.fn((identity: Readonly<ProviderIdentity>) => {
        if (identity.providerEmail !== "allowed@example.com") throw new Error("Enrollment denied");
      });
      const allowedIdentity = {
        provider: "slack" as const,
        providerUserId: "allowed",
        providerEmail: " Allowed@Example.COM ",
      };
      const deniedIdentity = {
        provider: "linear" as const,
        providerUserId: "denied",
        providerEmail: " Denied@Example.COM ",
      };

      await store.resolveOrCreateUser(allowedIdentity, requireAdmission);
      await expect(store.resolveOrCreateUser(deniedIdentity, requireAdmission)).rejects.toThrow(
        "Enrollment denied"
      );

      expect(requireAdmission).toHaveBeenNthCalledWith(1, {
        ...allowedIdentity,
        providerEmail: "allowed@example.com",
      });
      expect(requireAdmission).toHaveBeenNthCalledWith(2, {
        ...deniedIdentity,
        providerEmail: "denied@example.com",
      });
      expect(await store.getIdentity("linear", "denied")).toBeNull();
      for (const table of ["users", "user_identities", "user_role_assignments"]) {
        expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first()).toEqual({
          count: 1,
        });
      }
    });

    it("does not repeat admission for a known identity or an existing email owner", async () => {
      const existing = await store.createUser({ email: "known@example.com" });
      await store.createIdentity({
        userId: existing.id,
        provider: "slack",
        providerUserId: "known",
      });
      const refuseNewUser = vi.fn(() => {
        throw new Error("Enrollment denied");
      });

      const known = await store.resolveOrCreateUser(
        { provider: "slack", providerUserId: "known" },
        refuseNewUser
      );
      const linked = await store.resolveOrCreateUser(
        { provider: "linear", providerUserId: "new-identity", providerEmail: "Known@Example.COM" },
        refuseNewUser
      );

      expect(known.id).toBe(existing.id);
      expect(linked.id).toBe(existing.id);
      expect(refuseNewUser).not.toHaveBeenCalled();
    });

    it.each(providerIssuers)("stores the canonical issuer for %s", async (provider, issuer) => {
      await enrollFixtureUser({
        provider,
        providerUserId: `${provider}-subject`,
      });

      const identity = await store.getIdentity(provider, `${provider}-subject`);
      expect(identity?.providerIssuer).toBe(issuer);
    });

    it("creates a new user with no email", async () => {
      const result = await enrollFixtureUser({
        provider: "github",
        providerUserId: "12345",
        displayName: "Alice",
      });

      expect(result.outcome).toBe("created");
      expect(result.displayName).toBe("Alice");
      expect(result.email).toBeNull();

      const user = await store.getUserById(result.id);
      expect(user).not.toBeNull();
      expect(user!.displayName).toBe("Alice");
      expect(user!.email).toBeNull();
      expect(
        await env.DB.prepare("SELECT team_id, source FROM team_memberships WHERE user_id = ?")
          .bind(result.id)
          .first()
      ).toBeNull();
    });

    it("creates a new user with email normalized to lowercase", async () => {
      const result = await enrollFixtureUser({
        provider: "github",
        providerUserId: "12345",
        displayName: "Alice",
        providerEmail: "Alice@Example.COM",
      });

      expect(result.outcome).toBe("created");
      expect(result.email).toBe("alice@example.com");

      const user = await store.getUserById(result.id);
      expect(user!.email).toBe("alice@example.com");

      // Identity email is also normalized
      const identity = await store.getIdentity("github", "12345");
      expect(identity!.providerEmail).toBe("alice@example.com");
    });

    it("treats whitespace-only provider emails as absent instead of persisting empty strings", async () => {
      // idx_users_email is unique: two users persisting "" would collide on
      // one slot. A blank email must normalize to NULL at every boundary.
      const first = await enrollFixtureUser({
        provider: "slack",
        providerUserId: "U1BLANK",
        providerEmail: "   ",
      });
      const second = await enrollFixtureUser({
        provider: "slack",
        providerUserId: "U2BLANK",
        providerEmail: "   ",
      });

      expect(first.email).toBeNull();
      expect(second.email).toBeNull();
      expect(second.id).not.toBe(first.id);
      expect((await store.getUserById(first.id))!.email).toBeNull();
      expect((await store.getIdentity("slack", "U1BLANK"))!.providerEmail).toBeNull();
      // A blank lookup matches nothing rather than an empty-string row.
      expect(await store.getUserByEmail("   ")).toBeNull();
    });

    it("attests slack- and linear-attributed emails as verified at creation", async () => {
      // Both platforms verify mailbox ownership (Slack confirms address
      // changes; Linear's email is its login credential), and the bots fetch
      // the address server-side — so ingress writes count as proof.
      const slack = await enrollFixtureUser({
        provider: "slack",
        providerUserId: "U1ATTEST",
        providerEmail: "slack.person@example.com",
      });
      const linear = await enrollFixtureUser({
        provider: "linear",
        providerUserId: "linear-attest",
        providerEmail: "linear.person@example.com",
      });

      expect((await store.getUserById(slack.id))!.emailVerified).toBe(true);
      expect((await store.getUserById(linear.id))!.emailVerified).toBe(true);
    });

    it("stores non-attesting attribution as a claim, not proof", async () => {
      const result = await enrollFixtureUser({
        provider: "github",
        providerUserId: "12345",
        providerEmail: "octocat@example.com",
      });

      const user = await store.getUserById(result.id);
      expect(user!.email).toBe("octocat@example.com");
      expect(user!.emailVerified).toBe(false);
    });

    it("returns existing user for known identity without mutating profile or identity metadata", async () => {
      const first = await enrollFixtureUser({
        provider: "github",
        providerUserId: "12345",
        displayName: "Alice",
      });

      const second = await enrollFixtureUser({
        provider: "github",
        providerUserId: "12345",
        displayName: "Alice Updated",
        providerLogin: "alice-login",
        providerEmail: "alice@example.com",
      });

      expect(second.id).toBe(first.id);
      expect(second.outcome).toBe("existing");
      expect(second.displayName).toBe("Alice");
      expect(second.email).toBeNull();

      await expect(store.getUserById(first.id)).resolves.toMatchObject({
        displayName: "Alice",
        email: null,
      });
      await expect(store.getIdentity("github", "12345")).resolves.toMatchObject({
        providerLogin: null,
        providerEmail: null,
      });
    });

    it("does not repair a missing role assignment during identity resolution", async () => {
      const first = await enrollFixtureUser({
        provider: "github",
        providerUserId: "missing-assignment",
      });
      await env.DB.prepare("DELETE FROM user_role_assignments WHERE user_id = ?")
        .bind(first.id)
        .run();

      await enrollFixtureUser({
        provider: "github",
        providerUserId: "missing-assignment",
      });

      const assignment = await env.DB.prepare(
        "SELECT role_id FROM user_role_assignments WHERE user_id = ?"
      )
        .bind(first.id)
        .first();
      expect(assignment).toBeNull();
    });

    it("links new identity to existing user by matching email", async () => {
      const github = await enrollFixtureUser({
        provider: "github",
        providerUserId: "gh-123",
        displayName: "Alice",
        providerEmail: "alice@example.com",
      });

      const slack = await enrollFixtureUser({
        provider: "slack",
        providerUserId: "USLACK456",
        displayName: "Alice (Slack)",
        providerEmail: "alice@example.com",
      });

      expect(slack.id).toBe(github.id);
      expect(slack.outcome).toBe("linked");

      const identities = await store.getIdentitiesForUser(github.id);
      expect(identities).toHaveLength(2);
      expect(identities.map((i) => i.provider).sort()).toEqual(["github", "slack"]);
    });

    it("links a Google identity to an existing GitHub user by matching verified email (F1/F2 link surface)", async () => {
      const github = await enrollFixtureUser({
        provider: "github",
        providerUserId: "gh-900",
        displayName: "Cole",
        providerEmail: "cole@example.com",
      });

      const google = await enrollFixtureUser({
        provider: "google",
        providerUserId: "google-sub-900",
        displayName: "Cole (Google)",
        providerEmail: "cole@example.com",
      });

      expect(google.id).toBe(github.id);
      expect(google.outcome).toBe("linked");

      const identities = await store.getIdentitiesForUser(github.id);
      expect(identities).toHaveLength(2);
      expect(identities.map((i) => i.provider).sort()).toEqual(["github", "google"]);

      // The Google login must not overwrite or masquerade as the GitHub identity:
      // each provider keeps its own provider_user_id (a Google sub never lands
      // under provider='github').
      const githubIdentity = identities.find((i) => i.provider === "github");
      const googleIdentity = identities.find((i) => i.provider === "google");
      expect(githubIdentity!.providerUserId).toBe("gh-900");
      expect(googleIdentity!.providerUserId).toBe("google-sub-900");
    });

    it("does not relink an existing identity when another user owns the reported email", async () => {
      const userA = await enrollFixtureUser({
        provider: "github",
        providerUserId: "gh-111",
        displayName: "User A",
        providerEmail: "shared@example.com",
      });
      const userB = await enrollFixtureUser({
        provider: "slack",
        providerUserId: "slack-222",
        displayName: "User B",
      });
      expect(userB.email).toBeNull();
      expect(userB.id).not.toBe(userA.id);

      const result = await enrollFixtureUser({
        provider: "slack",
        providerUserId: "slack-222",
        displayName: "User B Updated",
        providerEmail: "shared@example.com",
      });

      expect(result).toEqual({
        id: userB.id,
        displayName: "User B",
        email: null,
        outcome: "existing",
      });
      await expect(store.getIdentitiesForUser(userA.id)).resolves.toMatchObject([
        { provider: "github", providerUserId: "gh-111" },
      ]);
      await expect(store.getIdentitiesForUser(userB.id)).resolves.toMatchObject([
        { provider: "slack", providerUserId: "slack-222", providerEmail: null },
      ]);
    });

    it("stores avatar_url on new user", async () => {
      const result = await enrollFixtureUser({
        provider: "github",
        providerUserId: "12345",
        displayName: "Alice",
        avatarUrl: "https://avatars.example.com/alice.png",
      });

      const user = await store.getUserById(result.id);
      expect(user!.avatarUrl).toBe("https://avatars.example.com/alice.png");
    });

    it("concurrent calls for same identity resolve to same user without orphans", async () => {
      const identity = {
        provider: "github" as const,
        providerUserId: "race-123",
        displayName: "Racer",
      };

      const [a, b] = await Promise.all([enrollFixtureUser(identity), enrollFixtureUser(identity)]);

      // Both resolve to the same canonical user
      expect(a.id).toBe(b.id);

      // Exactly one identity row exists (no duplicates)
      const identities = await store.getIdentitiesForUser(a.id);
      expect(identities).toHaveLength(1);

      // No orphaned user rows — count all users in the table
      const allUsers = await env.DB.prepare("SELECT COUNT(*) as cnt FROM users").first<{
        cnt: number;
      }>();
      expect(allUsers!.cnt).toBe(1);
    });
  });

  // ── fillMissingProfile ──────────────────────────────────────────

  describe("fillMissingProfile", () => {
    it("fills a NULL or blank display name and avatar with trimmed values", async () => {
      const nameless = await store.createUser({});
      const blank = await store.createUser({ displayName: "  ", avatarUrl: "" });

      for (const user of [nameless, blank]) {
        await store.fillMissingProfile(user.id, {
          displayName: "  Ada Lovelace ",
          avatarUrl: " https://avatars.test/ada.png ",
        });
        await expect(store.getUserById(user.id)).resolves.toMatchObject({
          displayName: "Ada Lovelace",
          avatarUrl: "https://avatars.test/ada.png",
        });
      }
    });

    it("keeps existing values and fills each missing field on its own", async () => {
      const user = await store.createUser({
        displayName: "Chosen Name",
        email: "chosen@example.com",
      });

      await store.fillMissingProfile(user.id, {
        displayName: "slack-handle",
        avatarUrl: "https://avatars.test/new.png",
      });

      await expect(store.getUserById(user.id)).resolves.toMatchObject({
        displayName: "Chosen Name",
        avatarUrl: "https://avatars.test/new.png",
        email: "chosen@example.com",
      });
    });

    it("ignores blank inputs and leaves updated_at alone when nothing is filled", async () => {
      const user = await store.createUser({});

      await store.fillMissingProfile(user.id, { displayName: "   ", avatarUrl: undefined });

      await expect(store.getUserById(user.id)).resolves.toMatchObject({
        displayName: null,
        avatarUrl: null,
        updatedAt: user.updatedAt,
      });
    });
  });

  // ── createIdentity ──────────────────────────────────────────────

  describe("createIdentity", () => {
    it.each(providerIssuers)("stores the canonical issuer for %s", async (provider, issuer) => {
      const user = await store.createUser({ displayName: "Alice" });
      await store.createIdentity({
        userId: user.id,
        provider,
        providerUserId: `${provider}-subject`,
      });

      const identity = await store.getIdentity(provider, `${provider}-subject`);
      expect(identity?.providerIssuer).toBe(issuer);
    });
  });

  // ── getUserById ─────────────────────────────────────────────────

  describe("getUserById", () => {
    it("returns user when found", async () => {
      const created = await enrollFixtureUser({
        provider: "github",
        providerUserId: "12345",
        displayName: "Alice",
        providerEmail: "alice@example.com",
      });

      const user = await store.getUserById(created.id);
      expect(user).not.toBeNull();
      expect(user!.id).toBe(created.id);
      expect(user!.displayName).toBe("Alice");
      expect(user!.email).toBe("alice@example.com");
      expect(user!.createdAt).toBeTypeOf("number");
      expect(user!.updatedAt).toBeTypeOf("number");
    });

    it("returns null when not found", async () => {
      const user = await store.getUserById("nonexistent");
      expect(user).toBeNull();
    });
  });

  // ── getIdentitiesForUser ────────────────────────────────────────

  describe("getIdentitiesForUser", () => {
    it("returns all identities for a user", async () => {
      const user = await enrollFixtureUser({
        provider: "github",
        providerUserId: "gh-123",
        displayName: "Alice",
        providerEmail: "alice@example.com",
      });

      // Second identity linked via email
      await enrollFixtureUser({
        provider: "slack",
        providerUserId: "slack-456",
        providerEmail: "alice@example.com",
      });

      const identities = await store.getIdentitiesForUser(user.id);
      expect(identities).toHaveLength(2);

      const github = identities.find((i) => i.provider === "github")!;
      expect(github.providerUserId).toBe("gh-123");
      expect(github.providerEmail).toBe("alice@example.com");

      const slack = identities.find((i) => i.provider === "slack")!;
      expect(slack.providerUserId).toBe("slack-456");
    });

    it("returns empty array when user has no identities", async () => {
      const identities = await store.getIdentitiesForUser("nonexistent");
      expect(identities).toEqual([]);
    });
  });

  // ── getIdentity ─────────────────────────────────────────────────

  describe("getIdentity", () => {
    it("returns identity when found", async () => {
      await enrollFixtureUser({
        provider: "github",
        providerUserId: "12345",
        displayName: "Alice",
        providerLogin: "alice",
      });

      const identity = await store.getIdentity("github", "12345");
      expect(identity).not.toBeNull();
      expect(identity!.provider).toBe("github");
      expect(identity!.providerUserId).toBe("12345");
      expect(identity!.providerLogin).toBe("alice");
      expect(identity!.createdAt).toBeTypeOf("number");
    });

    it("returns null when not found", async () => {
      const identity = await store.getIdentity("github", "nonexistent");
      expect(identity).toBeNull();
    });
  });
});
