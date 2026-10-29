import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import type { ServiceName } from "@open-inspect/shared/service-auth";
import { IdentityClaimStore } from "../../src/db/identity-claim-store";
import { UserStore } from "../../src/db/user-store";
import { KnownActorProfileClaim } from "../../src/routing/known-actor-profile";
import { cleanD1Tables } from "./cleanup";
import { serviceFetch } from "./helpers";

/**
 * Bots enroll an actor on its first control-plane request, which may carry no
 * profile (the Slack bot reads the channel's repos and environments before it
 * launches). Admission applies a later request's claims to the known actor:
 * missing fields are filled, existing ones kept, and the identity never moves.
 */

const SESSIONS_URL = "https://test.local/sessions";

function createSession(
  service: ServiceName,
  actor: string,
  profile: Record<string, unknown>
): Promise<Response> {
  return serviceFetch(SESSIONS_URL, {
    service,
    method: "POST",
    actor,
    body: JSON.stringify({
      title: "Profile claims",
      model: "anthropic/claude-haiku-4-5",
      ...profile,
    }),
  });
}

const ACTORS_ME_URL = "https://test.local/actors/me";

function enrollActor(actor: string, profile: Record<string, unknown>): Promise<Response> {
  return serviceFetch(ACTORS_ME_URL, {
    service: "slack-bot",
    method: "POST",
    actor,
    body: JSON.stringify(profile),
  });
}

describe("known service actor profile claims", () => {
  let users: UserStore;

  beforeEach(async () => {
    await cleanD1Tables();
    users = new UserStore(env.DB);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function enrollNameless(provider: "slack" | "linear", providerUserId: string) {
    return users.resolveOrCreateUser({ provider, providerUserId }, () => {});
  }

  it("refuses to enroll a new Slack actor without an attested email and writes nothing", async () => {
    const claimLess = await serviceFetch(SESSIONS_URL, {
      service: "slack-bot",
      actor: "slack:U-NO-EMAIL",
    });
    const empty = await enrollActor("slack:U-NO-EMAIL", { displayName: "Ada" });
    const blank = await enrollActor("slack:U-NO-EMAIL", { email: "   " });

    for (const response of [claimLess, empty, blank]) {
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ code: "actor_email_required" });
    }
    await expect(users.getIdentity("slack", "U-NO-EMAIL")).resolves.toBeNull();
    await expect(
      env.DB.prepare("SELECT COUNT(*) AS count FROM users").first<{ count: number }>()
    ).resolves.toEqual({ count: 0 });
  });

  it("admits a known Slack actor without an email", async () => {
    await enrollNameless("slack", "U-KNOWN-NO-EMAIL");

    expect((await enrollActor("slack:U-KNOWN-NO-EMAIL", {})).status).toBe(204);
    const read = await serviceFetch(SESSIONS_URL, {
      service: "slack-bot",
      actor: "slack:U-KNOWN-NO-EMAIL",
    });
    expect(read.status).toBe(200);
  });

  it("refuses a new Linear actor on a claim-less first contact", async () => {
    const firstContact = await serviceFetch(SESSIONS_URL, {
      service: "linear-bot",
      actor: "linear:U-NAMELESS-FIRST",
    });

    expect(firstContact.status).toBe(403);
    await expect(firstContact.json()).resolves.toMatchObject({ code: "actor_email_required" });
    await expect(users.getIdentity("linear", "U-NAMELESS-FIRST")).resolves.toBeNull();
  });

  it("completes a legacy nameless Slack actor's profile", async () => {
    // Slack actors enrolled without claims before enrollment required an email.
    const legacy = await enrollNameless("slack", "U-NAMELESS-FIRST");
    await expect(users.getUserById(legacy.id)).resolves.toMatchObject({
      displayName: null,
      email: null,
    });

    const created = await createSession("slack-bot", "slack:U-NAMELESS-FIRST", {
      actorDisplayName: "Ada Lovelace",
      actorEmail: "Ada@Corp.test",
      actorAvatarUrl: "https://avatars.slack.test/ada.png",
    });

    expect(created.status).toBe(201);
    await expect(users.getUserById(legacy.id)).resolves.toMatchObject({
      displayName: "Ada Lovelace",
      avatarUrl: "https://avatars.slack.test/ada.png",
      email: "ada@corp.test",
      emailVerified: true,
    });
  });

  it("links a Slack actor to the user owning its email when it enrolls before a claim-less read", async () => {
    const ada = await users.createUser({
      displayName: "Ada Lovelace",
      email: "ada@example.com",
      emailVerified: true,
    });

    const enrolled = await enrollActor("slack:U-X", {
      displayName: "Ada",
      email: "ada@example.com",
    });
    expect(enrolled.status).toBe(204);
    const catalogRead = await serviceFetch("https://test.local/environments?channel=slack:C-X", {
      service: "slack-bot",
      actor: "slack:U-X",
    });
    expect(catalogRead.status).toBe(200);
    const created = await createSession("slack-bot", "slack:U-X", {
      actorDisplayName: "Ada",
      actorEmail: "ada@example.com",
    });

    expect(created.status).toBe(201);
    await expect(users.getIdentity("slack", "U-X")).resolves.toMatchObject({ userId: ada.id });
    await expect(
      env.DB.prepare("SELECT user_id AS userId FROM sessions").first<{ userId: string }>()
    ).resolves.toEqual({ userId: ada.id });
  });

  it("refuses enrollment without an actor or with an unknown field and writes nothing", async () => {
    const actorless = await serviceFetch(ACTORS_ME_URL, {
      service: "slack-bot",
      method: "POST",
      body: JSON.stringify({ email: "ada@example.com" }),
    });
    expect(actorless.status).toBe(403);
    await expect(actorless.json()).resolves.toMatchObject({ code: "service_actor_required" });

    const unknownField = await enrollActor("slack:U-UNKNOWN-FIELD", {
      email: "ada@example.com",
      userId: "forged",
    });
    expect(unknownField.status).toBe(400);

    await expect(users.getIdentity("slack", "U-UNKNOWN-FIELD")).resolves.toBeNull();
    await expect(
      env.DB.prepare("SELECT COUNT(*) AS count FROM users").first<{ count: number }>()
    ).resolves.toEqual({ count: 0 });
  });

  it("refuses an unknown field from a known actor and claims nothing from it", async () => {
    const known = await enrollNameless("slack", "U-KNOWN");

    // Admission skips a known actor's refused claims, so the handler answers.
    const unknownField = await enrollActor("slack:U-KNOWN", {
      email: "ada@example.com",
      userId: "forged",
    });
    expect(unknownField.status).toBe(400);

    await expect(users.getUserById(known.id)).resolves.toMatchObject({ email: null });
  });

  it("claims an attested email over a legacy blank stored email", async () => {
    const legacy = await enrollNameless("slack", "U-LEGACY-BLANK");
    // Migration 0057 trims a whitespace-only legacy email to ''.
    await env.DB.prepare("UPDATE users SET email = '' WHERE id = ?").bind(legacy.id).run();

    const created = await createSession("slack-bot", "slack:U-LEGACY-BLANK", {
      actorEmail: "legacy@corp.test",
    });

    expect(created.status).toBe(201);
    await expect(users.getUserById(legacy.id)).resolves.toMatchObject({
      email: "legacy@corp.test",
      emailVerified: true,
    });
  });

  it("does not report a split when a concurrent request claimed the email for this user", async () => {
    const nameless = await enrollNameless("slack", "U-CONCURRENT");
    const claimStore = new IdentityClaimStore(env.DB);
    const findEmailOwnerId = claimStore.findEmailOwnerId.bind(claimStore);
    // The concurrent claim lands after this request read the missing email
    // and before it looks up the email's owner.
    vi.spyOn(claimStore, "findEmailOwnerId").mockImplementation(async (email) => {
      await claimStore.claimEmail(nameless.id, email);
      return findEmailOwnerId(email);
    });
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});

    await new KnownActorProfileClaim(users, claimStore).claim(
      {
        provider: "slack",
        providerUserId: "U-CONCURRENT",
        participantUserId: "slack:U-CONCURRENT",
        canonicalUserId: nameless.id,
      },
      { email: "concurrent@corp.test" }
    );

    expect(warnings.mock.calls.map(([line]) => JSON.parse(String(line)))).not.toContainEqual(
      expect.objectContaining({ event: "auth.subject_email_collision" })
    );
    await expect(users.getUserById(nameless.id)).resolves.toMatchObject({
      email: "concurrent@corp.test",
      emailVerified: true,
    });
  });

  it.each(["another user", "the same user", "a different email"] as const)(
    "handles a concurrent claim for %s between the owner lookup and guarded write",
    async (race) => {
      const nameless = await enrollNameless("slack", "U-CLAIM-RACE");
      const other = await users.createUser({ displayName: "Other User" });
      const email = "race@corp.test";
      const claimStore = new IdentityClaimStore(env.DB);
      const claimEmail = claimStore.claimEmail.bind(claimStore);
      const ownerLookup = vi.spyOn(claimStore, "findEmailOwnerId");
      // Let the initial lookup see no owner, then commit a real competing
      // write before the actor's guarded UPDATE. No database result is mocked.
      const guardedClaim = vi
        .spyOn(claimStore, "claimEmail")
        .mockImplementationOnce(async (userId, claimedEmail) => {
          expect(ownerLookup).toHaveBeenCalledExactlyOnceWith(email);
          expect(await ownerLookup.mock.results[0].value).toBeNull();
          expect(
            await claimEmail(
              race === "another user" ? other.id : nameless.id,
              race === "a different email" ? "different@corp.test" : claimedEmail
            )
          ).toBe(true);
          return claimEmail(userId, claimedEmail);
        });
      const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
      const info = vi.spyOn(console, "log").mockImplementation(() => {});

      await new KnownActorProfileClaim(users, claimStore).claim(
        {
          provider: "slack",
          providerUserId: "U-CLAIM-RACE",
          participantUserId: "slack:U-CLAIM-RACE",
          canonicalUserId: nameless.id,
        },
        { email }
      );

      await expect(guardedClaim.mock.results[0].value).resolves.toBe(false);
      const collisions = warnings.mock.calls
        .map(([line]) => JSON.parse(String(line)))
        .filter(({ event }) => event === "auth.subject_email_collision");
      if (race === "another user") {
        expect(collisions).toEqual([
          expect.objectContaining({
            level: "warn",
            provider: "slack",
            subject: "U-CLAIM-RACE",
            subject_user_id: nameless.id,
            email_owner_user_id: other.id,
          }),
        ]);
      } else {
        expect(collisions).toEqual([]);
      }
      expect(info.mock.calls.map(([line]) => JSON.parse(String(line)))).not.toContainEqual(
        expect.objectContaining({ event: "auth.email_claimed" })
      );
      await expect(users.getUserById(nameless.id)).resolves.toMatchObject({
        email:
          race === "another user" ? null : race === "the same user" ? email : "different@corp.test",
        emailVerified: race !== "another user",
      });
      await expect(users.getUserById(other.id)).resolves.toMatchObject({
        email: race === "another user" ? email : null,
        emailVerified: race === "another user",
      });
      await expect(users.getIdentity("slack", "U-CLAIM-RACE")).resolves.toMatchObject({
        userId: nameless.id,
        providerEmail: null,
      });
    }
  );

  it("keeps a known actor's existing name, avatar, and email", async () => {
    const known = await users.resolveOrCreateUser(
      {
        provider: "linear",
        providerUserId: "LIN-NAMED",
        displayName: "Chosen Name",
        providerEmail: "chosen@corp.test",
        avatarUrl: "https://avatars.linear.test/kept.png",
      },
      () => {}
    );

    const created = await createSession("linear-bot", "linear:LIN-NAMED", {
      actorDisplayName: "linear-handle",
      actorEmail: "other@corp.test",
      actorAvatarUrl: "https://avatars.linear.test/new.png",
    });

    expect(created.status).toBe(201);
    await expect(users.getUserById(known.id)).resolves.toMatchObject({
      displayName: "Chosen Name",
      avatarUrl: "https://avatars.linear.test/kept.png",
      email: "chosen@corp.test",
    });
  });

  it("reports an email owned by another user as a split and never relinks", async () => {
    const nameless = await enrollNameless("slack", "U-SPLIT");
    const webUser = await users.createUser({
      displayName: "Web User",
      email: "split@corp.test",
      emailVerified: true,
    });

    const created = await createSession("slack-bot", "slack:U-SPLIT", {
      actorDisplayName: "Split Person",
      actorEmail: "split@corp.test",
    });

    expect(created.status).toBe(201);
    await expect(users.getUserById(nameless.id)).resolves.toMatchObject({
      displayName: "Split Person",
      email: null,
      emailVerified: false,
    });
    await expect(users.getIdentity("slack", "U-SPLIT")).resolves.toMatchObject({
      userId: nameless.id,
      providerEmail: null,
    });
    await expect(users.getUserById(webUser.id)).resolves.toMatchObject({
      displayName: "Web User",
    });
    await expect(
      env.DB.prepare("SELECT user_id AS userId FROM sessions").first<{ userId: string }>()
    ).resolves.toEqual({ userId: nameless.id });
  });

  it("converges to the same known-actor state when enrollment lands after authentication", async () => {
    const nameless = await enrollNameless("slack", "U-SPLIT-LATE");
    const webUser = await users.createUser({
      displayName: "Web User",
      email: "split@corp.test",
      emailVerified: true,
    });
    // Simulate a request that authenticated before the concurrent nameless
    // enrollment wrote the identity, so finalizeServiceActor takes the
    // canonicalUserId === null -> resolveOrCreateUser (outcome: "existing") path.
    vi.spyOn(UserStore.prototype, "getIdentity").mockResolvedValueOnce(null);
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});

    const created = await createSession("slack-bot", "slack:U-SPLIT-LATE", {
      actorDisplayName: "Split Person",
      actorEmail: "split@corp.test",
      actorAvatarUrl: "https://avatars.slack.test/split.png",
    });

    expect(created.status).toBe(201);
    expect(warnings.mock.calls.map(([line]) => JSON.parse(String(line)))).toContainEqual(
      expect.objectContaining({
        event: "auth.subject_email_collision",
        provider: "slack",
        subject: "U-SPLIT-LATE",
        subject_user_id: nameless.id,
        email_owner_user_id: webUser.id,
      })
    );
    await expect(users.getUserById(nameless.id)).resolves.toMatchObject({
      displayName: "Split Person",
      avatarUrl: "https://avatars.slack.test/split.png",
      email: null,
      emailVerified: false,
    });
    await expect(users.getIdentity("slack", "U-SPLIT-LATE")).resolves.toMatchObject({
      userId: nameless.id,
      providerEmail: null,
    });
    await expect(users.getUserById(webUser.id)).resolves.toMatchObject({
      displayName: "Web User",
    });
    await expect(
      env.DB.prepare("SELECT user_id AS userId FROM sessions").first<{ userId: string }>()
    ).resolves.toEqual({ userId: nameless.id });

    // A second late-enrolled request with different claims preserves the
    // existing display name and avatar, matching the known-actor rule.
    vi.spyOn(UserStore.prototype, "getIdentity").mockResolvedValueOnce(null);
    const second = await createSession("slack-bot", "slack:U-SPLIT-LATE", {
      actorDisplayName: "Overwritten Name",
      actorEmail: "split@corp.test",
      actorAvatarUrl: "https://avatars.slack.test/overwritten.png",
    });

    expect(second.status).toBe(201);
    await expect(users.getUserById(nameless.id)).resolves.toMatchObject({
      displayName: "Split Person",
      avatarUrl: "https://avatars.slack.test/split.png",
      email: null,
      emailVerified: false,
    });
  });

  it("admits the request when late profile enrichment fails in finalizeServiceActor", async () => {
    const nameless = await enrollNameless("slack", "U-LATE-FAIL");
    vi.spyOn(UserStore.prototype, "getIdentity").mockResolvedValueOnce(null);
    vi.spyOn(UserStore.prototype, "fillMissingProfile").mockRejectedValueOnce(
      new Error("d1 transient failure")
    );
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});

    const created = await createSession("slack-bot", "slack:U-LATE-FAIL", {
      actorDisplayName: "Transient Failure",
      actorEmail: "transient@corp.test",
    });

    expect(created.status).toBe(201);
    expect(warnings.mock.calls.map(([line]) => JSON.parse(String(line)))).toContainEqual(
      expect.objectContaining({
        event: "auth.service_actor_profile_failed",
      })
    );
    await expect(
      env.DB.prepare("SELECT user_id AS userId FROM sessions").first<{ userId: string }>()
    ).resolves.toEqual({ userId: nameless.id });
  });

  it("admits a known actor's request when its route's claims extractor throws", async () => {
    const known = await enrollNameless("slack", "U-EXTRACT-FAIL");
    // A known actor's claims are read from a clone of the request.
    vi.spyOn(Request.prototype, "clone").mockImplementationOnce(() => {
      throw new Error("claims extractor failure");
    });
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});

    const created = await createSession("slack-bot", "slack:U-EXTRACT-FAIL", {
      actorDisplayName: "Extract Failure",
      actorEmail: "extract@corp.test",
    });

    expect(created.status).toBe(201);
    expect(warnings.mock.calls.map(([line]) => JSON.parse(String(line)))).toContainEqual(
      expect.objectContaining({
        event: "auth.service_actor_profile_failed",
        error_message: "claims extractor failure",
      })
    );
    await expect(users.getUserById(known.id)).resolves.toMatchObject({
      displayName: null,
      email: null,
    });
    await expect(
      env.DB.prepare("SELECT user_id AS userId FROM sessions").first<{ userId: string }>()
    ).resolves.toEqual({ userId: known.id });
  });

  it("never claims an email from a provider that does not attest it", async () => {
    const created = await serviceFetch(SESSIONS_URL, {
      service: "github-bot",
      method: "GET",
      actor: "github:2468",
    });
    expect(created.status).toBe(200);
    const identity = await users.getIdentity("github", "2468");

    const response = await createSession("github-bot", "github:2468", {
      actorDisplayName: "Octo Person",
      actorEmail: "octo@corp.test",
    });

    expect(response.status).toBe(201);
    await expect(users.getUserById(identity!.userId)).resolves.toMatchObject({
      displayName: "Octo Person",
      email: null,
    });
  });

  it("completes the profile even when RBAC denies the request, as first contact does", async () => {
    const suspended = await enrollNameless("slack", "U-SUSPENDED");
    await env.DB.prepare("UPDATE users SET suspended_at = 1 WHERE id = ?").bind(suspended.id).run();

    const denied = await createSession("slack-bot", "slack:U-SUSPENDED", {
      actorDisplayName: "Suspended Person",
      actorEmail: "suspended@corp.test",
    });

    expect(denied.status).toBe(403);
    await expect(users.getUserById(suspended.id)).resolves.toMatchObject({
      displayName: "Suspended Person",
      email: "suspended@corp.test",
    });
    await expect(
      env.DB.prepare("SELECT COUNT(*) AS count FROM sessions").first<{ count: number }>()
    ).resolves.toEqual({ count: 0 });
  });

  it("writes nothing for a body the route refuses and still answers with the route's error", async () => {
    const nameless = await enrollNameless("slack", "U-REFUSED");

    const refused = await createSession("slack-bot", "slack:U-REFUSED", {
      userId: "forged",
      actorDisplayName: "Should Not Be Saved",
    });

    expect(refused.status).toBe(400);
    await expect(refused.json()).resolves.toMatchObject({
      error: "Field 'userId' is not accepted from verified callers",
    });
    await expect(users.getUserById(nameless.id)).resolves.toMatchObject({ displayName: null });
  });
});
