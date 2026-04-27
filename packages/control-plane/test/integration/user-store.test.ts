import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { UserStore } from "../../src/db/user-store";
import { cleanD1Tables } from "./cleanup";

describe("UserStore", () => {
  let store: UserStore;

  beforeEach(async () => {
    await cleanD1Tables();
    store = new UserStore(env.DB);
  });

  // ── resolveOrCreateUser ─────────────────────────────────────────

  describe("resolveOrCreateUser", () => {
    it("creates a new user with no email", async () => {
      const result = await store.resolveOrCreateUser({
        provider: "github",
        providerUserId: "12345",
        displayName: "Alice",
      });

      expect(result.isNew).toBe(true);
      expect(result.displayName).toBe("Alice");
      expect(result.email).toBeNull();

      const user = await store.getUserById(result.id);
      expect(user).not.toBeNull();
      expect(user!.displayName).toBe("Alice");
      expect(user!.email).toBeNull();
    });

    it("creates a new user with email normalized to lowercase", async () => {
      const result = await store.resolveOrCreateUser({
        provider: "github",
        providerUserId: "12345",
        displayName: "Alice",
        providerEmail: "Alice@Example.COM",
      });

      expect(result.isNew).toBe(true);
      expect(result.email).toBe("alice@example.com");

      const user = await store.getUserById(result.id);
      expect(user!.email).toBe("alice@example.com");

      // Identity email is also normalized
      const identity = await store.getIdentity("github", "12345");
      expect(identity!.providerEmail).toBe("alice@example.com");
    });

    it("returns existing user for known identity and updates display_name", async () => {
      const first = await store.resolveOrCreateUser({
        provider: "github",
        providerUserId: "12345",
        displayName: "Alice",
      });
      const beforeUpdate = await store.getUserById(first.id);

      const second = await store.resolveOrCreateUser({
        provider: "github",
        providerUserId: "12345",
        displayName: "Alice Updated",
      });

      expect(second.id).toBe(first.id);
      expect(second.isNew).toBe(false);
      expect(second.displayName).toBe("Alice Updated");

      const user = await store.getUserById(first.id);
      expect(user!.displayName).toBe("Alice Updated");
      expect(user!.updatedAt).toBeGreaterThanOrEqual(beforeUpdate!.updatedAt);
    });

    it("links new identity to existing user by matching email", async () => {
      const github = await store.resolveOrCreateUser({
        provider: "github",
        providerUserId: "gh-123",
        displayName: "Alice",
        providerEmail: "alice@example.com",
      });

      const slack = await store.resolveOrCreateUser({
        provider: "slack",
        providerUserId: "USLACK456",
        displayName: "Alice (Slack)",
        providerEmail: "alice@example.com",
      });

      expect(slack.id).toBe(github.id);
      expect(slack.isNew).toBe(false);

      const identities = await store.getIdentitiesForUser(github.id);
      expect(identities).toHaveLength(2);
      expect(identities.map((i) => i.provider).sort()).toEqual(["github", "slack"]);
    });

    it("backfills email on existing user when email becomes available", async () => {
      // Create user without email (e.g. Slack bot before users:read.email scope)
      const first = await store.resolveOrCreateUser({
        provider: "slack",
        providerUserId: "UABC",
        displayName: "Alice",
      });
      expect(first.email).toBeNull();

      // Same identity, now with email
      const second = await store.resolveOrCreateUser({
        provider: "slack",
        providerUserId: "UABC",
        displayName: "Alice",
        providerEmail: "alice@example.com",
      });

      expect(second.id).toBe(first.id);
      expect(second.email).toBe("alice@example.com");

      const user = await store.getUserById(first.id);
      expect(user!.email).toBe("alice@example.com");
    });

    it("refreshes identity metadata on repeat sign-in", async () => {
      // Create user without email or login
      await store.resolveOrCreateUser({
        provider: "slack",
        providerUserId: "UABC",
        displayName: "Alice",
      });

      const before = await store.getIdentity("slack", "UABC");
      expect(before!.providerEmail).toBeNull();
      expect(before!.providerLogin).toBeNull();

      // Same identity, now with email and login (after Slack scope added)
      await store.resolveOrCreateUser({
        provider: "slack",
        providerUserId: "UABC",
        displayName: "Alice",
        providerLogin: "alice.smith",
        providerEmail: "alice@example.com",
      });

      const after = await store.getIdentity("slack", "UABC");
      expect(after!.providerEmail).toBe("alice@example.com");
      expect(after!.providerLogin).toBe("alice.smith");
    });

    it("re-links identity to email-owning user when email conflict is discovered", async () => {
      // User A owns the email (e.g. GitHub login)
      const userA = await store.resolveOrCreateUser({
        provider: "github",
        providerUserId: "gh-111",
        displayName: "User A",
        providerEmail: "shared@example.com",
      });

      // User B created without email (e.g. Slack before users:read.email scope)
      const userB = await store.resolveOrCreateUser({
        provider: "slack",
        providerUserId: "slack-222",
        displayName: "User B",
      });
      expect(userB.email).toBeNull();
      expect(userB.id).not.toBe(userA.id);

      // User B's provider now reports the same email — identity should
      // re-link to User A (same principle as step 3 email-based linking)
      const result = await store.resolveOrCreateUser({
        provider: "slack",
        providerUserId: "slack-222",
        displayName: "User B",
        providerEmail: "shared@example.com",
      });

      expect(result.id).toBe(userA.id);
      expect(result.email).toBe("shared@example.com");

      // Both identities now belong to User A
      const identities = await store.getIdentitiesForUser(userA.id);
      expect(identities).toHaveLength(2);
      expect(identities.map((i) => i.provider).sort()).toEqual(["github", "slack"]);
    });

    it("stores avatar_url on new user", async () => {
      const result = await store.resolveOrCreateUser({
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

      const [a, b] = await Promise.all([
        store.resolveOrCreateUser(identity),
        store.resolveOrCreateUser(identity),
      ]);

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

  // ── getUserById ─────────────────────────────────────────────────

  describe("getUserById", () => {
    it("returns user when found", async () => {
      const created = await store.resolveOrCreateUser({
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
      const user = await store.resolveOrCreateUser({
        provider: "github",
        providerUserId: "gh-123",
        displayName: "Alice",
        providerEmail: "alice@example.com",
      });

      // Second identity linked via email
      await store.resolveOrCreateUser({
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
      await store.resolveOrCreateUser({
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
