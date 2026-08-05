import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { IdentityReconciliationStore } from "../../src/db/identity-reconciliation";
import { runIdentityReconciliation } from "../../src/db/identity-reconciliation-job";
import { cleanD1Tables } from "./cleanup";
import {
  countTableRows,
  getAuthUserRow,
  insertAuthAccount,
  insertAuthUser,
  insertCanonicalUser,
  insertIdentity,
} from "./identity-seed-helpers";

/**
 * Consistency report (R1-R4) and scheduled reconciliation coverage. Each
 * report is exercised against the *missing-row* state it exists to catch
 * (anti-join blindness), and every auto-repair is verified to stay inside its
 * safe scope: idempotent inserts, zero-account email alignment, zero-account
 * strand sweeps — never verification, never account-bearing rows.
 */

beforeEach(async () => {
  await cleanD1Tables();
});

function store(): IdentityReconciliationStore {
  return new IdentityReconciliationStore(env.DB);
}

describe("R1: accounts missing identity projection", () => {
  it("reports the missing projection and repairs it with the account's issuer", async () => {
    const userId = "11111111111111111111111111111111";
    await insertCanonicalUser({ id: userId, email: "person@example.com" });
    await insertAuthUser({ id: userId, email: "person@example.com", emailVerified: 1 });
    await insertAuthAccount({
      id: "a1111111111111111111111111111111",
      accountId: "583231",
      providerId: "github",
      userId,
    });

    const before = await store().report();
    expect(before.accountsMissingIdentity).toEqual([
      { providerId: "github", accountId: "583231", userId, hasCanonicalUser: true },
    ]);

    const stats = await store().applySafeRepairs();
    expect(stats.identitiesProjected).toBe(1);

    expect(
      await env.DB.prepare(
        `SELECT user_id, provider_issuer FROM user_identities
         WHERE provider = 'github' AND provider_user_id = '583231'`
      ).first<{ user_id: string; provider_issuer: string }>()
    ).toEqual({ user_id: userId, provider_issuer: "https://github.com" });
    const after = await store().report();
    expect(after.accountsMissingIdentity).toEqual([]);
  });

  it("never inserts identities for canonical-less orphan accounts (FK exclusion)", async () => {
    const strandId = "21111111111111111111111111111111";
    await insertAuthUser({ id: strandId, email: "strand@example.com", emailVerified: 1 });
    await insertAuthAccount({
      id: "a2111111111111111111111111111111",
      accountId: "999",
      providerId: "github",
      userId: strandId,
    });

    const report = await store().report();
    expect(report.accountsMissingIdentity).toEqual([
      { providerId: "github", accountId: "999", userId: strandId, hasCanonicalUser: false },
    ]);

    const stats = await store().applySafeRepairs();
    expect(stats.identitiesProjected).toBe(0);
    expect(await countTableRows("user_identities")).toBe(0);
  });
});

describe("R2: auth users inconsistent with their canonical user", () => {
  it("aligns zero-account email drift without minting verification", async () => {
    const userId = "31111111111111111111111111111111";
    await insertCanonicalUser({ id: userId, email: "current@example.com" });
    await insertAuthUser({ id: userId, email: "stale@example.com", emailVerified: 0 });

    const before = await store().report();
    expect(before.authUserDrift).toEqual([
      {
        userId,
        canonicalEmail: "current@example.com",
        authEmail: "stale@example.com",
        emailVerified: 0,
        accountCount: 0,
      },
    ]);

    const stats = await store().applySafeRepairs();
    expect(stats.emailsAligned).toBe(1);

    // Email aligned; verification is never minted by reconciliation.
    expect(await getAuthUserRow(userId)).toMatchObject({
      email: "current@example.com",
      emailVerified: 0,
    });
  });

  it("reports but never touches account-bearing drift", async () => {
    const userId = "41111111111111111111111111111111";
    await insertCanonicalUser({ id: userId, email: "canonical@example.com" });
    await insertAuthUser({ id: userId, email: "authoritative@example.com", emailVerified: 1 });
    await insertAuthAccount({
      id: "a4111111111111111111111111111111",
      accountId: "gh-4",
      providerId: "github",
      userId,
    });

    const report = await store().report();
    expect(report.authUserDrift).toEqual([
      {
        userId,
        canonicalEmail: "canonical@example.com",
        authEmail: "authoritative@example.com",
        emailVerified: 1,
        accountCount: 1,
      },
    ]);

    await store().applySafeRepairs();
    expect(await getAuthUserRow(userId)).toMatchObject({
      email: "authoritative@example.com",
    });
  });

  it("skips alignment when another auth user owns the canonical email", async () => {
    const userId = "51111111111111111111111111111111";
    const otherId = "52111111111111111111111111111111";
    await insertCanonicalUser({ id: userId, email: "contested@example.com" });
    await insertAuthUser({ id: userId, email: "stale@example.com", emailVerified: 0 });
    // A canonical-less strand holds the target email with an account, so it
    // survives sweeps and blocks alignment (auth_users.email is UNIQUE).
    await insertAuthUser({ id: otherId, email: "contested@example.com", emailVerified: 1 });
    await insertAuthAccount({
      id: "a5211111111111111111111111111111",
      accountId: "gh-52",
      providerId: "github",
      userId: otherId,
    });

    const stats = await store().applySafeRepairs();
    expect(stats.emailsAligned).toBe(0);
    expect(await getAuthUserRow(userId)).toMatchObject({ email: "stale@example.com" });
  });
});

describe("R3: canonical-less auth users", () => {
  it("sweeps zero-account strands and reports account-bearing strands untouched", async () => {
    const zeroAccountStrand = "61111111111111111111111111111111";
    const accountBearingStrand = "62111111111111111111111111111111";
    await insertAuthUser({ id: zeroAccountStrand, email: "zero@example.com", emailVerified: 1 });
    await insertAuthUser({
      id: accountBearingStrand,
      email: "active@example.com",
      emailVerified: 1,
    });
    await insertAuthAccount({
      id: "a6211111111111111111111111111111",
      accountId: "gh-62",
      providerId: "github",
      userId: accountBearingStrand,
    });

    const before = await store().report();
    expect(before.canonicalLessAuthUsers).toEqual([
      { userId: zeroAccountStrand, accountCount: 0 },
      { userId: accountBearingStrand, accountCount: 1 },
    ]);

    const stats = await store().applySafeRepairs();
    expect(stats.strandsSwept).toBe(1);

    expect(await getAuthUserRow(zeroAccountStrand)).toBeNull();
    expect(await getAuthUserRow(accountBearingStrand)).not.toBeNull();
    const after = await store().report();
    expect(after.canonicalLessAuthUsers).toEqual([
      { userId: accountBearingStrand, accountCount: 1 },
    ]);
  });
});

describe("R4: shared-subject conflicts", () => {
  it("enumerates subjects owned by different users across the registries and never auto-repairs them", async () => {
    const botUserId = "71111111111111111111111111111111";
    const webUserId = "72111111111111111111111111111111";
    await insertCanonicalUser({ id: botUserId, email: null, displayName: "Bot Row" });
    await insertCanonicalUser({ id: webUserId, email: "web@example.com" });
    await insertIdentity({
      id: "i7111111111111111111111111111111",
      userId: botUserId,
      provider: "github",
      providerUserId: "583231",
      issuer: "https://github.com",
    });
    await insertAuthUser({ id: webUserId, email: "web@example.com", emailVerified: 1 });
    await insertAuthAccount({
      id: "a7211111111111111111111111111111",
      accountId: "583231",
      providerId: "github",
      userId: webUserId,
    });

    const report = await store().report();
    expect(report.sharedSubjectConflicts).toEqual([
      { botUserId, webUserId, providerId: "github", accountId: "583231" },
    ]);

    await store().applySafeRepairs();

    // Untouched: merge is operator work (the split-merge script).
    expect(
      await env.DB.prepare(
        `SELECT user_id FROM user_identities WHERE provider = 'github' AND provider_user_id = '583231'`
      ).first<{ user_id: string }>()
    ).toEqual({ user_id: botUserId });
    expect((await store().report()).sharedSubjectConflicts).toHaveLength(1);
  });
});

describe("scheduled reconciliation run", () => {
  it("applies safe repairs and reports residual conflicts", async () => {
    // R1-repairable: account with canonical user, missing identity.
    const userId = "81111111111111111111111111111111";
    await insertCanonicalUser({ id: userId, email: "person@example.com" });
    await insertAuthUser({ id: userId, email: "person@example.com", emailVerified: 1 });
    await insertAuthAccount({
      id: "a8111111111111111111111111111111",
      accountId: "583231",
      providerId: "github",
      userId,
    });
    // R3-sweepable zero-account strand.
    await insertAuthUser({ id: "82111111111111111111111111111111", email: "strand@example.com" });

    const stats = await runIdentityReconciliation(env.DB);

    expect(stats).toMatchObject({
      identitiesProjected: 1,
      strandsSwept: 1,
      residualSharedSubjectConflicts: 0,
      residualAccountBearingDrift: 0,
      residualAccountBearingStrands: 0,
    });
    expect(await countTableRows("user_identities")).toBe(1);
    expect(await getAuthUserRow("82111111111111111111111111111111")).toBeNull();
  });
});
