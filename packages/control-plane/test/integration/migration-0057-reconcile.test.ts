import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanD1Tables } from "./cleanup";
import {
  SEED_NOW_MS,
  countTableRows,
  getAuthUserRow,
  insertAuthAccount,
  insertAuthSession,
  insertAuthUser,
  insertCanonicalUser,
  insertIdentity,
} from "./identity-seed-helpers";

/**
 * Drift-safety tests for migration 0057 (canonical/auth identity repair).
 *
 * The migration must complete without constraint violations against every
 * post-cutover drift state reachable since 2026-07-26 — a failing statement
 * aborts the Terraform apply and blocks the control-plane deploy. Each test
 * seeds one trap state from the design's §4b list, re-executes the migration's
 * statements, and asserts the repaired outcome.
 */

function migrationQueries(): string[] {
  const migration = env.TEST_MIGRATIONS.find((entry) => entry.name.startsWith("0057"));
  if (!migration) throw new Error("Migration 0057 not found in TEST_MIGRATIONS");
  return migration.queries;
}

async function applyReconcileMigration(): Promise<void> {
  for (const query of migrationQueries()) {
    await env.DB.prepare(query).run();
  }
}

beforeEach(async () => {
  await cleanD1Tables();
});

describe("migration 0057: canonical/auth identity reconciliation", () => {
  it("sweeps stranded zero-account auth rows whose email belongs to another canonical user (cohort 4)", async () => {
    const canonicalId = "11111111111111111111111111111111";
    const strandedId = "99999999999999999999999999999999";
    await insertCanonicalUser({ id: canonicalId, email: "person@example.com" });
    // Failed first sign-in left a generated-id auth row (no account was ever
    // written) holding the email.
    await insertAuthUser({ id: strandedId, email: "person@example.com" });
    await insertAuthSession({ id: "s1111111111111111111111111111111", userId: strandedId });

    await applyReconcileMigration();

    expect(await getAuthUserRow(strandedId)).toBeNull();
    expect(await countTableRows("auth_sessions")).toBe(0);
    // The canonical owner is re-seeded, pre-verified for implicit linking.
    expect(await getAuthUserRow(canonicalId)).toMatchObject({
      email: "person@example.com",
      emailVerified: 1,
    });
  });

  it("preserves account-bearing auth graphs even when their email disagrees with the canonical registry", async () => {
    // A live sign-in target: auth user with an OAuth account whose same-id
    // canonical row holds a different (stale) email, while another canonical
    // user owns the auth email's normalized value. Email disagreement alone
    // must never classify an account-bearing graph as disposable — deleting
    // it would cascade away real accounts and sessions.
    const liveId = "12111111111111111111111111111111";
    const otherOwnerId = "13111111111111111111111111111111";
    await insertCanonicalUser({ id: liveId, email: "stale@example.com" });
    await insertAuthUser({ id: liveId, email: "current@example.com", emailVerified: 1 });
    await insertAuthAccount({
      id: "a1211111111111111111111111111111",
      accountId: "gh-12",
      providerId: "github",
      userId: liveId,
    });
    await insertAuthSession({ id: "s1211111111111111111111111111111", userId: liveId });
    await insertCanonicalUser({ id: otherOwnerId, email: "current@example.com" });

    await applyReconcileMigration();

    // The live graph is intact: account-bearing rows are Better Auth's to
    // govern (same authority rule as step 2), and the collision is left for
    // the consistency report as operator merge work.
    expect(await getAuthUserRow(liveId)).toMatchObject({
      email: "current@example.com",
      emailVerified: 1,
    });
    expect(await countTableRows("auth_accounts")).toBe(1);
    expect(await countTableRows("auth_sessions")).toBe(1);
    // The other canonical owner is not seeded (its email slot is reserved by
    // the live row) — enumerated by the R5 email-reservation report.
    expect(await getAuthUserRow(otherOwnerId)).toBeNull();
  });

  it("seeds missing auth_users rows for emailed canonical users with emailVerified = 1 (cohorts 2-3)", async () => {
    const emailedId = "21111111111111111111111111111111";
    const emaillessId = "22111111111111111111111111111111";
    await insertCanonicalUser({
      id: emailedId,
      email: "slack.person@example.com",
      displayName: "Slack Person",
    });
    await insertCanonicalUser({ id: emaillessId, email: null, displayName: "GitHub Person" });

    await applyReconcileMigration();

    expect(await getAuthUserRow(emailedId)).toMatchObject({
      name: "Slack Person",
      email: "slack.person@example.com",
      emailVerified: 1,
    });
    // auth_users.email is NOT NULL — email-less canonical users cannot be seeded.
    expect(await getAuthUserRow(emaillessId)).toBeNull();
  });

  it("verifies pre-existing unverified reservations whose email matches the canonical user (cohort 3 backlog)", async () => {
    const userId = "31111111111111111111111111111111";
    await insertCanonicalUser({ id: userId, email: "backlog@example.com" });
    await insertAuthUser({ id: userId, email: "backlog@example.com", emailVerified: 0 });

    await applyReconcileMigration();

    expect(await getAuthUserRow(userId)).toMatchObject({
      email: "backlog@example.com",
      emailVerified: 1,
    });
  });

  it("repairs same-id email drift on zero-account rows and leaves account-bearing drift for the report", async () => {
    const zeroAccountId = "41111111111111111111111111111111";
    const accountBearingId = "42111111111111111111111111111111";
    await insertCanonicalUser({ id: zeroAccountId, email: "current@example.com" });
    await insertAuthUser({ id: zeroAccountId, email: "stale@example.com", emailVerified: 0 });
    await insertCanonicalUser({ id: accountBearingId, email: "canonical@example.com" });
    await insertAuthUser({
      id: accountBearingId,
      email: "authoritative@example.com",
      emailVerified: 1,
    });
    await insertAuthAccount({
      id: "a4211111111111111111111111111111",
      accountId: "gh-42",
      providerId: "github",
      userId: accountBearingId,
    });

    await applyReconcileMigration();

    // Zero accounts: the canonical email wins and the row is verified.
    expect(await getAuthUserRow(zeroAccountId)).toMatchObject({
      email: "current@example.com",
      emailVerified: 1,
    });
    // Accounts present: Better Auth is authoritative — untouched.
    expect(await getAuthUserRow(accountBearingId)).toMatchObject({
      email: "authoritative@example.com",
      emailVerified: 1,
    });
  });

  it("seeds auth_accounts from sign-in identities and skips subjects owned by another auth user", async () => {
    const cleanId = "51111111111111111111111111111111";
    await insertCanonicalUser({ id: cleanId, email: "clean@example.com" });
    await insertIdentity({
      id: "i5111111111111111111111111111111",
      userId: cleanId,
      provider: "github",
      providerUserId: "777",
      issuer: "https://github.com",
    });

    // Pre-existing split: bot user owns the identity, web user owns the account
    // for the same subject. 0049's (providerId, accountId, userId) guard would
    // pass and abort on idx_auth_accounts_provider_identity; 0057 must skip.
    const botUserId = "52111111111111111111111111111111";
    const webUserId = "53111111111111111111111111111111";
    await insertCanonicalUser({ id: botUserId, email: "bot.person@example.com" });
    await insertCanonicalUser({ id: webUserId, email: "web.person@example.com" });
    await insertIdentity({
      id: "i5211111111111111111111111111111",
      userId: botUserId,
      provider: "github",
      providerUserId: "888",
      issuer: "https://github.com",
    });
    await insertAuthUser({ id: webUserId, email: "web.person@example.com", emailVerified: 1 });
    await insertAuthAccount({
      id: "a5311111111111111111111111111111",
      accountId: "888",
      providerId: "github",
      userId: webUserId,
    });

    // Non-sign-in identities must never become auth accounts.
    const slackUserId = "54111111111111111111111111111111";
    await insertCanonicalUser({ id: slackUserId, email: "slack.only@example.com" });
    await insertIdentity({
      id: "i5411111111111111111111111111111",
      userId: slackUserId,
      provider: "slack",
      providerUserId: "U0SLACK",
      issuer: null,
    });

    await applyReconcileMigration();

    expect(
      await env.DB.prepare(
        `SELECT userId FROM auth_accounts WHERE providerId = 'github' AND accountId = '777'`
      ).first<{ userId: string }>()
    ).toEqual({ userId: cleanId });
    // The split subject stays with its web owner; no constraint violation.
    expect(
      await env.DB.prepare(
        `SELECT userId FROM auth_accounts WHERE providerId = 'github' AND accountId = '888'`
      ).first<{ userId: string }>()
    ).toEqual({ userId: webUserId });
    expect(
      await env.DB.prepare(`SELECT id FROM auth_accounts WHERE providerId = 'slack'`).first()
    ).toBeNull();
  });

  it("backfills user_identities from auth_accounts, skipping canonical-less strands (FK safety)", async () => {
    const webFirstId = "61111111111111111111111111111111";
    await insertCanonicalUser({ id: webFirstId, email: "web.first@example.com" });
    await insertAuthUser({ id: webFirstId, email: "web.first@example.com", emailVerified: 1 });
    await insertAuthAccount({
      id: "a6111111111111111111111111111111",
      accountId: "999",
      providerId: "github",
      userId: webFirstId,
    });

    // Canonical-less auth strand with an account: identity backfill must skip
    // it rather than violating user_identities.user_id's foreign key.
    const strandId = "62111111111111111111111111111111";
    await insertAuthUser({ id: strandId, email: "strand.only@example.com", emailVerified: 1 });
    await insertAuthAccount({
      id: "a6211111111111111111111111111111",
      accountId: "1000",
      providerId: "google",
      userId: strandId,
    });

    await applyReconcileMigration();

    const identity = await env.DB.prepare(
      `SELECT user_id, provider, provider_user_id, provider_issuer, created_at
       FROM user_identities WHERE provider = 'github' AND provider_user_id = '999'`
    ).first<{
      user_id: string;
      provider: string;
      provider_user_id: string;
      provider_issuer: string;
      created_at: number;
    }>();
    expect(identity).toMatchObject({
      user_id: webFirstId,
      provider_issuer: "https://github.com",
    });
    // Better Auth DATE strings convert to the table's INTEGER epoch-ms format.
    expect(identity?.created_at).toBe(SEED_NOW_MS);

    expect(
      await env.DB.prepare(
        `SELECT id FROM user_identities WHERE provider = 'google' AND provider_user_id = '1000'`
      ).first()
    ).toBeNull();
    // The strand row itself is preserved for the R3 report (it survives the
    // sweep because no other canonical user owns its email).
    expect(await getAuthUserRow(strandId)).not.toBeNull();
  });

  it("does not duplicate existing rows when identities and accounts already agree", async () => {
    const userId = "71111111111111111111111111111111";
    await insertCanonicalUser({ id: userId, email: "linked@example.com" });
    await insertIdentity({
      id: "i7111111111111111111111111111111",
      userId,
      provider: "github",
      providerUserId: "1234",
      issuer: "https://github.com",
    });
    await insertAuthUser({ id: userId, email: "linked@example.com", emailVerified: 1 });
    await insertAuthAccount({
      id: "i7111111111111111111111111111111",
      accountId: "1234",
      providerId: "github",
      userId,
    });

    await applyReconcileMigration();

    expect(await countTableRows("auth_users")).toBe(1);
    expect(await countTableRows("auth_accounts")).toBe(1);
    expect(await countTableRows("user_identities")).toBe(1);
  });

  it("preserves healthy whitespace-variant email pairs instead of sweeping or aborting", async () => {
    // idx_users_email is COLLATE NOCASE but not whitespace-normalizing, so
    // two canonical users can normalize to one email. The active user whose
    // auth row matches their own canonical email must survive the sweep, and
    // seeding the variant must skip rather than abort the deploy.
    const activeId = "91111111111111111111111111111111";
    const variantId = "92111111111111111111111111111111";
    await insertCanonicalUser({ id: activeId, email: " person@example.com" });
    await insertAuthUser({ id: activeId, email: "person@example.com", emailVerified: 1 });
    await insertAuthAccount({
      id: "a9111111111111111111111111111111",
      accountId: "gh-91",
      providerId: "github",
      userId: activeId,
    });
    await insertCanonicalUser({ id: variantId, email: "person@example.com" });

    await applyReconcileMigration();

    // The active user's auth graph is intact.
    expect(await getAuthUserRow(activeId)).toMatchObject({
      email: "person@example.com",
      emailVerified: 1,
    });
    expect(await countTableRows("auth_accounts")).toBe(1);
    // The variant is skipped (its email slot is taken) — enumerated by the
    // R5 email-reservation report, not a deploy abort.
    expect(await getAuthUserRow(variantId)).toBeNull();
  });

  it("falls back to now for unparseable auth account timestamps instead of violating NOT NULL", async () => {
    const userId = "93111111111111111111111111111111";
    await insertCanonicalUser({ id: userId, email: "odd.time@example.com" });
    await insertAuthUser({ id: userId, email: "odd.time@example.com", emailVerified: 1 });
    await insertAuthAccount({
      id: "a9311111111111111111111111111111",
      accountId: "gh-93",
      providerId: "github",
      userId,
    });
    // A createdAt strftime cannot parse: NULL would violate
    // user_identities.created_at NOT NULL and abort the deploy.
    await env.DB.prepare(`UPDATE auth_accounts SET createdAt = 'not-a-timestamp' WHERE id = ?`)
      .bind("a9311111111111111111111111111111")
      .run();

    await applyReconcileMigration();

    const identity = await env.DB.prepare(
      `SELECT created_at FROM user_identities WHERE provider = 'github' AND provider_user_id = 'gh-93'`
    ).first<{ created_at: number }>();
    expect(identity).not.toBeNull();
    expect(identity!.created_at).toBeGreaterThan(0);
  });

  it("is idempotent: a second run leaves the database unchanged", async () => {
    const emailedId = "81111111111111111111111111111111";
    await insertCanonicalUser({ id: emailedId, email: "repeat@example.com" });
    await insertIdentity({
      id: "i8111111111111111111111111111111",
      userId: emailedId,
      provider: "github",
      providerUserId: "4321",
      issuer: "https://github.com",
    });

    await applyReconcileMigration();
    const snapshot = async () => ({
      authUsers: (
        await env.DB.prepare(
          `SELECT id, name, email, emailVerified, image FROM auth_users ORDER BY id`
        ).all()
      ).results,
      authAccounts: (
        await env.DB.prepare(
          `SELECT id, accountId, providerId, userId FROM auth_accounts ORDER BY id`
        ).all()
      ).results,
      identities: (
        await env.DB.prepare(
          `SELECT user_id, provider, provider_user_id, provider_issuer
           FROM user_identities ORDER BY provider, provider_user_id`
        ).all()
      ).results,
    });
    const first = await snapshot();

    await applyReconcileMigration();

    expect(await snapshot()).toEqual(first);
  });
});
