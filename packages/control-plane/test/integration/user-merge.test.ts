import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { IdentityReconciliationStore } from "../../src/db/identity-reconciliation";
import { mergeUsers, UserMergeError } from "../../src/db/user-merge";
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
 * Split-merge coverage (Appendix A): converging a loser canonical user's
 * whole graph — bot identities, auth graph, sessions, automations, SCM
 * tokens, read states — onto a survivor, with the documented dedup rules and
 * dry-run/idempotency guarantees.
 */

const SURVIVOR = "aaaa1111111111111111111111111111";
const LOSER = "bbbb2222222222222222222222222222";

async function insertSession(id: string, userId: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO sessions (id, repo_owner, repo_name, status, created_at, updated_at, user_id)
     VALUES (?, 'acme', 'app', 'completed', ?, ?, ?)`
  )
    .bind(id, SEED_NOW_MS, SEED_NOW_MS, userId)
    .run();
}

async function insertAutomation(id: string, userId: string, createdBy: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO automations (
       id, name, instructions, model, created_by, user_id, created_at, updated_at
     ) VALUES (?, ?, 'instructions', 'anthropic/claude-sonnet-5', ?, ?, ?, ?)`
  )
    .bind(id, `automation-${id}`, createdBy, userId, SEED_NOW_MS, SEED_NOW_MS)
    .run();
}

async function insertReadState(userId: string, sessionId: string, messageId: string) {
  await env.DB.prepare(
    `INSERT INTO session_read_states (user_id, session_id, last_read_message_id, updated_at)
     VALUES (?, ?, ?, ?)`
  )
    .bind(userId, sessionId, messageId, SEED_NOW_MS)
    .run();
}

async function insertScmToken(providerUserId: string, userId: string) {
  await env.DB.prepare(
    `INSERT INTO user_scm_tokens (
       provider_user_id, access_token_encrypted, refresh_token_encrypted,
       token_expires_at, created_at, updated_at, user_id
     ) VALUES (?, 'enc-access', 'enc-refresh', ?, ?, ?, ?)`
  )
    .bind(providerUserId, SEED_NOW_MS, SEED_NOW_MS, SEED_NOW_MS, userId)
    .run();
}

beforeEach(async () => {
  await cleanD1Tables();
});

describe("mergeUsers", () => {
  it("converges a cohort-6 shared-subject split onto the email owner", async () => {
    // Loser: the bot-era GitHub row owning the subject identity and history.
    await insertCanonicalUser({ id: LOSER, email: null, displayName: "GitHub Row" });
    await insertIdentity({
      id: "i1111111111111111111111111111111",
      userId: LOSER,
      provider: "github",
      providerUserId: "583231",
      issuer: "https://github.com",
    });
    await insertSession("session-loser", LOSER);
    await insertAutomation("auto-1", LOSER, LOSER);
    await insertScmToken("583231", LOSER);
    // Survivor: the email-owning row the user already signs into.
    await insertCanonicalUser({ id: SURVIVOR, email: "person@example.com" });
    await insertAuthUser({ id: SURVIVOR, email: "person@example.com", emailVerified: 1 });
    await insertAuthAccount({
      id: "acc11111111111111111111111111111",
      accountId: "583231",
      providerId: "github",
      userId: SURVIVOR,
    });
    await insertSession("session-survivor", SURVIVOR);
    // Both read the same session: the (user_id, session_id) PK collision case.
    await insertReadState(LOSER, "session-survivor", "msg-loser");
    await insertReadState(SURVIVOR, "session-survivor", "msg-survivor");
    await insertReadState(LOSER, "session-loser", "msg-only-loser");

    const result = await mergeUsers(env.DB, { survivorId: SURVIVOR, loserId: LOSER });

    expect(result.dryRun).toBe(false);
    expect(result.counts).toMatchObject({
      identitiesRepointed: 1,
      sessionsRepointed: 1,
      automationsOwnedRepointed: 1,
      automationsCreatedRepointed: 1,
      scmTokensRepointed: 1,
      readStatesDeduped: 1,
      readStatesRepointed: 1,
      usersDeleted: 1,
    });

    // The subject bridge now agrees with the auth registry.
    expect(
      await env.DB.prepare(
        `SELECT user_id FROM user_identities WHERE provider = 'github' AND provider_user_id = '583231'`
      ).first<{ user_id: string }>()
    ).toEqual({ user_id: SURVIVOR });
    expect(
      await env.DB.prepare(`SELECT user_id FROM sessions WHERE id = 'session-loser'`).first<{
        user_id: string;
      }>()
    ).toEqual({ user_id: SURVIVOR });
    expect(
      await env.DB.prepare(
        `SELECT user_id, created_by FROM automations WHERE id = 'auto-1'`
      ).first<{
        user_id: string;
        created_by: string;
      }>()
    ).toEqual({ user_id: SURVIVOR, created_by: SURVIVOR });
    expect(
      await env.DB.prepare(
        `SELECT user_id FROM user_scm_tokens WHERE provider_user_id = '583231'`
      ).first<{ user_id: string }>()
    ).toEqual({ user_id: SURVIVOR });
    // Read-state dedup kept the survivor's row on the shared session.
    expect(
      await env.DB.prepare(
        `SELECT last_read_message_id FROM session_read_states
         WHERE user_id = ? AND session_id = 'session-survivor'`
      )
        .bind(SURVIVOR)
        .first<{ last_read_message_id: string }>()
    ).toEqual({ last_read_message_id: "msg-survivor" });
    expect(
      await env.DB.prepare(
        `SELECT user_id FROM session_read_states WHERE session_id = 'session-loser'`
      ).first<{ user_id: string }>()
    ).toEqual({ user_id: SURVIVOR });
    // The loser's canonical row is gone and the report is clean.
    expect(
      await env.DB.prepare(`SELECT id FROM users WHERE id = ?`).bind(LOSER).first()
    ).toBeNull();
    const report = await new IdentityReconciliationStore(env.DB).report();
    expect(report.sharedSubjectConflicts).toEqual([]);
    expect(report.canonicalLessAuthUsers).toEqual([]);
  });

  it("moves the loser's auth graph when the survivor has none, signing the loser out once", async () => {
    // Survivor: bot-era row that owns history (normal backlog direction).
    await insertCanonicalUser({ id: SURVIVOR, email: null, displayName: "Bot Row" });
    await insertIdentity({
      id: "i2111111111111111111111111111111",
      userId: SURVIVOR,
      provider: "github",
      providerUserId: "583231",
      issuer: "https://github.com",
    });
    // Loser: the phantom web-registered row with the auth graph.
    await insertCanonicalUser({ id: LOSER, email: "person@example.com" });
    await insertAuthUser({ id: LOSER, email: "person@example.com", emailVerified: 1 });
    await insertAuthAccount({
      id: "acc21111111111111111111111111111",
      accountId: "583231",
      providerId: "github",
      userId: LOSER,
    });
    await insertAuthSession({ id: "authsess-1", userId: LOSER });

    const result = await mergeUsers(env.DB, { survivorId: SURVIVOR, loserId: LOSER });

    expect(result.counts).toMatchObject({
      authUsersDeleted: 1,
      authUserCreatedForSurvivor: 1,
      authAccountsMoved: 1,
      usersDeleted: 1,
    });
    // The loser's auth user is gone (their session cascade signs them out
    // once); the survivor inherited the verified email and the account.
    expect(await getAuthUserRow(LOSER)).toBeNull();
    expect(await countTableRows("auth_sessions")).toBe(0);
    expect(await getAuthUserRow(SURVIVOR)).toMatchObject({
      email: "person@example.com",
      emailVerified: 1,
    });
    expect(
      await env.DB.prepare(
        `SELECT userId FROM auth_accounts WHERE providerId = 'github' AND accountId = '583231'`
      ).first<{ userId: string }>()
    ).toEqual({ userId: SURVIVOR });
    // The NULL-email survivor acquired the freed canonical email.
    expect(
      await env.DB.prepare(`SELECT email FROM users WHERE id = ?`).bind(SURVIVOR).first<{
        email: string;
      }>()
    ).toEqual({ email: "person@example.com" });

    const report = await new IdentityReconciliationStore(env.DB).report();
    expect(report.sharedSubjectConflicts).toEqual([]);
    expect(report.accountsMissingIdentity).toEqual([]);
  });

  it("keeps the survivor's own auth identity when both sides have auth rows", async () => {
    await insertCanonicalUser({ id: SURVIVOR, email: "survivor@example.com" });
    await insertAuthUser({ id: SURVIVOR, email: "survivor@example.com", emailVerified: 1 });
    await insertAuthAccount({
      id: "acc31111111111111111111111111111",
      accountId: "google-s",
      providerId: "google",
      userId: SURVIVOR,
    });
    await insertCanonicalUser({ id: LOSER, email: "loser@example.com" });
    await insertAuthUser({ id: LOSER, email: "loser@example.com", emailVerified: 1 });
    await insertAuthAccount({
      id: "acc32111111111111111111111111111",
      accountId: "github-l",
      providerId: "github",
      userId: LOSER,
    });

    const result = await mergeUsers(env.DB, { survivorId: SURVIVOR, loserId: LOSER });

    expect(result.counts).toMatchObject({
      authUsersDeleted: 1,
      authUserCreatedForSurvivor: 0,
      authAccountsMoved: 1,
      usersDeleted: 1,
    });
    // The survivor's email is untouched; both accounts now belong to it.
    expect(await getAuthUserRow(SURVIVOR)).toMatchObject({
      email: "survivor@example.com",
      emailVerified: 1,
    });
    const accounts = await env.DB.prepare(
      `SELECT providerId, userId FROM auth_accounts ORDER BY providerId`
    ).all<{ providerId: string; userId: string }>();
    expect(accounts.results).toEqual([
      { providerId: "github", userId: SURVIVOR },
      { providerId: "google", userId: SURVIVOR },
    ]);
    expect(await getAuthUserRow(LOSER)).toBeNull();
  });

  it("starts the survivor's auth row unverified when the surviving email is not the loser's proven email", async () => {
    await insertCanonicalUser({ id: SURVIVOR, email: null });
    await insertCanonicalUser({ id: LOSER, email: "proven@example.com" });
    await insertAuthUser({ id: LOSER, email: "proven@example.com", emailVerified: 1 });

    const result = await mergeUsers(env.DB, {
      survivorId: SURVIVOR,
      loserId: LOSER,
      survivingEmail: "chosen@example.com",
    });

    expect(result.counts.authUserCreatedForSurvivor).toBe(1);
    // Verification is the implicit-linking gate — it never transfers to an
    // email that did not complete OAuth.
    expect(await getAuthUserRow(SURVIVOR)).toMatchObject({
      email: "chosen@example.com",
      emailVerified: 0,
    });
  });

  it("previews all counts without writing in dry-run mode", async () => {
    await insertCanonicalUser({ id: SURVIVOR, email: "person@example.com" });
    await insertCanonicalUser({ id: LOSER, email: null });
    await insertIdentity({
      id: "i3111111111111111111111111111111",
      userId: LOSER,
      provider: "github",
      providerUserId: "583231",
      issuer: "https://github.com",
    });
    await insertSession("session-1", LOSER);

    const result = await mergeUsers(env.DB, {
      survivorId: SURVIVOR,
      loserId: LOSER,
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.counts).toMatchObject({
      identitiesRepointed: 1,
      sessionsRepointed: 1,
      usersDeleted: 1,
    });
    // Nothing moved.
    expect(
      await env.DB.prepare(
        `SELECT user_id FROM user_identities WHERE provider_user_id = '583231'`
      ).first<{ user_id: string }>()
    ).toEqual({ user_id: LOSER });
    expect(await env.DB.prepare(`SELECT id FROM users WHERE id = ?`).bind(LOSER).first()).toEqual({
      id: LOSER,
    });
  });

  it("leaves non-canonical created_by values (legacy GitHub numeric ids) untouched", async () => {
    await insertCanonicalUser({ id: SURVIVOR, email: "person@example.com" });
    await insertCanonicalUser({ id: LOSER, email: null });
    await insertAutomation("auto-legacy", LOSER, "583231");

    const result = await mergeUsers(env.DB, { survivorId: SURVIVOR, loserId: LOSER });

    expect(result.counts.automationsCreatedRepointed).toBe(0);
    expect(
      await env.DB.prepare(
        `SELECT created_by, user_id FROM automations WHERE id = 'auto-legacy'`
      ).first<{ created_by: string; user_id: string }>()
    ).toEqual({ created_by: "583231", user_id: SURVIVOR });
  });

  it("is idempotent: re-running after a completed merge is a zero-count no-op", async () => {
    await insertCanonicalUser({ id: SURVIVOR, email: "person@example.com" });
    await insertCanonicalUser({ id: LOSER, email: null });
    await insertSession("session-1", LOSER);
    await mergeUsers(env.DB, { survivorId: SURVIVOR, loserId: LOSER });

    const second = await mergeUsers(env.DB, { survivorId: SURVIVOR, loserId: LOSER });

    expect(second.counts).toMatchObject({
      identitiesRepointed: 0,
      sessionsRepointed: 0,
      usersDeleted: 0,
    });
    expect(await countTableRows("users")).toBe(1);
  });

  it("rejects a surviving email owned by a third auth user before writing anything", async () => {
    await insertCanonicalUser({ id: SURVIVOR, email: null });
    await insertCanonicalUser({ id: LOSER, email: "person@example.com" });
    await insertAuthUser({ id: LOSER, email: "person@example.com", emailVerified: 1 });
    await insertSession("session-1", LOSER);
    // A third auth user owns the requested surviving email.
    await insertAuthUser({
      id: "cccc3333333333333333333333333333",
      email: "taken@example.com",
      emailVerified: 1,
    });

    await expect(
      mergeUsers(env.DB, {
        survivorId: SURVIVOR,
        loserId: LOSER,
        survivingEmail: "taken@example.com",
      })
    ).rejects.toThrow(UserMergeError);

    // Validate-before-delete: nothing moved.
    expect(
      await env.DB.prepare(`SELECT user_id FROM sessions WHERE id = 'session-1'`).first<{
        user_id: string;
      }>()
    ).toEqual({ user_id: LOSER });
    expect(await getAuthUserRow(LOSER)).not.toBeNull();
  });

  it("resumes after an interruption that already parked the loser's email", async () => {
    // Mid-merge state from a sequential-transport failure: the loser's auth
    // email is parked on the placeholder, the survivor's auth row does not
    // exist yet, and the loser's canonical row still holds the real email.
    await insertCanonicalUser({ id: SURVIVOR, email: null, displayName: "Bot Row" });
    await insertCanonicalUser({ id: LOSER, email: "person@example.com" });
    await insertAuthUser({
      id: LOSER,
      email: `merged-${LOSER}@merge.invalid`,
      emailVerified: 1,
    });
    await insertAuthAccount({
      id: "acc41111111111111111111111111111",
      accountId: "583231",
      providerId: "github",
      userId: LOSER,
    });

    // No explicit survivingEmail: the re-run must recover it on its own.
    const result = await mergeUsers(env.DB, { survivorId: SURVIVOR, loserId: LOSER });

    expect(result.counts).toMatchObject({
      authUserCreatedForSurvivor: 1,
      authAccountsMoved: 1,
      usersDeleted: 1,
    });
    // The surviving email came from the loser's canonical row; the parked
    // placeholder never propagates, and verification does not transfer to an
    // email that was not the loser's OAuth-proven auth email.
    expect(await getAuthUserRow(SURVIVOR)).toMatchObject({
      email: "person@example.com",
      emailVerified: 0,
    });
    expect(await getAuthUserRow(LOSER)).toBeNull();
    expect(
      await env.DB.prepare(
        `SELECT userId FROM auth_accounts WHERE providerId = 'github' AND accountId = '583231'`
      ).first<{ userId: string }>()
    ).toEqual({ userId: SURVIVOR });
  });

  it("resumes after an interruption that already created the survivor's auth row", async () => {
    // Later interruption point: survivor auth row exists with the real
    // email, loser row is still parked, accounts not yet re-pointed.
    await insertCanonicalUser({ id: SURVIVOR, email: null });
    await insertCanonicalUser({ id: LOSER, email: "person@example.com" });
    await insertAuthUser({ id: SURVIVOR, email: "person@example.com", emailVerified: 1 });
    await insertAuthUser({
      id: LOSER,
      email: `merged-${LOSER}@merge.invalid`,
      emailVerified: 1,
    });
    await insertAuthAccount({
      id: "acc51111111111111111111111111111",
      accountId: "583231",
      providerId: "github",
      userId: LOSER,
    });

    const result = await mergeUsers(env.DB, { survivorId: SURVIVOR, loserId: LOSER });

    expect(result.counts).toMatchObject({ authAccountsMoved: 1, usersDeleted: 1 });
    expect(await getAuthUserRow(SURVIVOR)).toMatchObject({
      email: "person@example.com",
      emailVerified: 1,
    });
    // The placeholder never reaches the canonical backfill.
    expect(
      await env.DB.prepare(`SELECT email FROM users WHERE id = ?`).bind(SURVIVOR).first<{
        email: string;
      }>()
    ).toEqual({ email: "person@example.com" });
    expect(await getAuthUserRow(LOSER)).toBeNull();
  });

  it("refuses up front when an interruption after parking would be unrecoverable", async () => {
    // Canonical-less loser: parking its auth email would destroy the only
    // stored copy, so the merge must demand an explicit surviving email
    // before writing anything.
    await insertCanonicalUser({ id: SURVIVOR, email: null });
    await insertAuthUser({ id: LOSER, email: "only-copy@example.com", emailVerified: 1 });
    await insertAuthAccount({
      id: "acc61111111111111111111111111111",
      accountId: "583231",
      providerId: "github",
      userId: LOSER,
    });

    await expect(mergeUsers(env.DB, { survivorId: SURVIVOR, loserId: LOSER })).rejects.toThrow(
      /not be resumable/
    );
    // Nothing was written — the loser's auth email is untouched.
    expect(await getAuthUserRow(LOSER)).toMatchObject({ email: "only-copy@example.com" });

    // With the email supplied explicitly, the same merge proceeds (and the
    // command line is re-runnable if interrupted).
    const result = await mergeUsers(env.DB, {
      survivorId: SURVIVOR,
      loserId: LOSER,
      survivingEmail: "only-copy@example.com",
    });
    expect(result.counts.authUserCreatedForSurvivor).toBe(1);
    expect(await getAuthUserRow(SURVIVOR)).toMatchObject({ email: "only-copy@example.com" });
  });

  it("normalizes legacy unnormalized auth emails before comparing or storing them", async () => {
    await insertCanonicalUser({ id: SURVIVOR, email: null });
    await insertCanonicalUser({ id: LOSER, email: "person@example.com" });
    // A legacy auth row written before trim/lowercase normalization.
    await insertAuthUser({ id: LOSER, email: " Person@Example.COM ", emailVerified: 1 });

    const result = await mergeUsers(env.DB, { survivorId: SURVIVOR, loserId: LOSER });

    expect(result.counts.authUserCreatedForSurvivor).toBe(1);
    // The stored surviving email is normalized, it still counts as the
    // loser's OAuth-proven email (verification transfers), and the canonical
    // backfill matches the reconciliation report's lower(trim(...)) rule.
    expect(await getAuthUserRow(SURVIVOR)).toMatchObject({
      email: "person@example.com",
      emailVerified: 1,
    });
    const report = await new IdentityReconciliationStore(env.DB).report();
    expect(report.authUserDrift).toEqual([]);
  });

  it("previews the canonical backfill with execute parity for a blank-email survivor", async () => {
    // Empty-string canonical email: the TS gate and the SQL predicate must
    // agree, so dry-run and execute report the same backfill count.
    await env.DB.prepare(
      `INSERT INTO users (id, email, created_at, updated_at) VALUES (?, '', ?, ?)`
    )
      .bind(SURVIVOR, SEED_NOW_MS, SEED_NOW_MS)
      .run();
    await insertCanonicalUser({ id: LOSER, email: "person@example.com" });
    await insertAuthUser({ id: LOSER, email: "person@example.com", emailVerified: 1 });

    const preview = await mergeUsers(env.DB, {
      survivorId: SURVIVOR,
      loserId: LOSER,
      dryRun: true,
    });
    const executed = await mergeUsers(env.DB, { survivorId: SURVIVOR, loserId: LOSER });

    expect(preview.counts.canonicalEmailBackfilled).toBe(1);
    expect(executed.counts.canonicalEmailBackfilled).toBe(preview.counts.canonicalEmailBackfilled);
    expect(
      await env.DB.prepare(`SELECT email FROM users WHERE id = ?`).bind(SURVIVOR).first<{
        email: string;
      }>()
    ).toEqual({ email: "person@example.com" });
  });

  it("rejects a missing survivor and a self-merge", async () => {
    await insertCanonicalUser({ id: LOSER, email: null });

    await expect(mergeUsers(env.DB, { survivorId: SURVIVOR, loserId: LOSER })).rejects.toThrow(
      UserMergeError
    );
    await expect(mergeUsers(env.DB, { survivorId: LOSER, loserId: LOSER })).rejects.toThrow(
      UserMergeError
    );
  });
});
