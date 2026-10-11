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
    return users.resolveOrCreateUser({ provider, providerUserId });
  }

  it("completes a Slack actor's profile after a nameless first contact", async () => {
    const firstContact = await serviceFetch(SESSIONS_URL, {
      service: "slack-bot",
      actor: "slack:U-NAMELESS-FIRST",
    });
    expect(firstContact.status).toBe(200);
    const identity = await users.getIdentity("slack", "U-NAMELESS-FIRST");
    await expect(users.getUserById(identity!.userId)).resolves.toMatchObject({
      displayName: null,
      email: null,
    });

    const created = await createSession("slack-bot", "slack:U-NAMELESS-FIRST", {
      actorDisplayName: "Ada Lovelace",
      actorEmail: "Ada@Corp.test",
      actorAvatarUrl: "https://avatars.slack.test/ada.png",
    });

    expect(created.status).toBe(201);
    await expect(users.getUserById(identity!.userId)).resolves.toMatchObject({
      displayName: "Ada Lovelace",
      avatarUrl: "https://avatars.slack.test/ada.png",
      email: "ada@corp.test",
      emailVerified: true,
    });
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

  it("keeps a known actor's existing name, avatar, and email", async () => {
    const known = await users.resolveOrCreateUser({
      provider: "linear",
      providerUserId: "LIN-NAMED",
      displayName: "Chosen Name",
      providerEmail: "chosen@corp.test",
      avatarUrl: "https://avatars.linear.test/kept.png",
    });

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
