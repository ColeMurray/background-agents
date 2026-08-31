import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { mergeUsers, UserMergeError } from "../../src/db/user-merge";
import { cleanD1Tables } from "./cleanup";
import {
  SEED_NOW_MS,
  countTableRows,
  getUserRow,
  insertAuthSession,
  insertCanonicalUser,
  insertIdentity,
} from "./identity-seed-helpers";

/**
 * Split-merge coverage over the consolidated registry: converging a loser
 * canonical user's whole graph — identities (which are also the Better Auth
 * accounts), coding and browser sessions, automations, SCM tokens, read
 * states — onto a survivor, with the documented dedup rules and
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

async function insertSkillProfile(id: string, userId: string, name: string) {
  await env.DB.prepare(
    `INSERT INTO skill_profiles (id, user_id, name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(id, userId, name, SEED_NOW_MS, SEED_NOW_MS)
    .run();
}

beforeEach(async () => {
  await cleanD1Tables();
});

describe("mergeUsers", () => {
  it("converges a divergent multi-surface split onto the survivor", async () => {
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
    await insertSkillProfile("profile-loser", LOSER, "Personal profile");
    await insertAuthSession({ id: "authsess-loser", userId: LOSER });
    // Survivor: the email-owning row the user already signs into.
    await insertCanonicalUser({ id: SURVIVOR, email: "person@example.com", emailVerified: 1 });
    await insertIdentity({
      id: "i1211111111111111111111111111111",
      userId: SURVIVOR,
      provider: "slack",
      providerUserId: "U0SLACK",
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
      authSessionsDeleted: 1,
      automationsOwnedRepointed: 1,
      automationsCreatedRepointed: 1,
      scmTokensRepointed: 1,
      skillProfilesRepointed: 1,
      readStatesDeduped: 1,
      readStatesRepointed: 1,
      usersDeleted: 1,
    });

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
    // Bearer sessions issued to the loser are invalidated, never re-keyed.
    expect(
      await env.DB.prepare(`SELECT userId FROM auth_sessions WHERE id = 'authsess-loser'`).first<{
        userId: string;
      }>()
    ).toBeNull();
    expect(
      await env.DB.prepare(
        `SELECT user_id, created_by FROM automations WHERE id = 'auto-1'`
      ).first<{
        user_id: string;
        created_by: string;
      }>()
    ).toEqual({ user_id: SURVIVOR, created_by: SURVIVOR });
    expect(
      await env.DB.prepare(`SELECT user_id FROM skill_profiles WHERE id = 'profile-loser'`).first()
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
    expect(await getUserRow(LOSER)).toBeNull();
    expect(await countTableRows("users")).toBe(1);
    expect(
      await env.DB.prepare(
        `SELECT principal_kind, actor_user_id_snapshot, actor_service_snapshot,
                resource_id, target_user_id_snapshot
         FROM authorization_audit_events WHERE action = 'workspace.user_merged'`
      ).first()
    ).toEqual({
      principal_kind: "service",
      actor_user_id_snapshot: null,
      actor_service_snapshot: "control-plane",
      resource_id: SURVIVOR,
      target_user_id_snapshot: LOSER,
    });
  });

  it("backfills the loser's email onto an email-less survivor, carrying verification as-was", async () => {
    await insertCanonicalUser({ id: SURVIVOR, email: null, displayName: "Bot Row" });
    await insertCanonicalUser({ id: LOSER, email: "person@example.com", emailVerified: 1 });

    const result = await mergeUsers(env.DB, { survivorId: SURVIVOR, loserId: LOSER });

    expect(result.counts.canonicalEmailBackfilled).toBe(1);
    expect(await getUserRow(SURVIVOR)).toMatchObject({
      email: "person@example.com",
      email_verified: 1,
    });
  });

  it("never upgrades verification through a merge", async () => {
    await insertCanonicalUser({ id: SURVIVOR, email: null });
    await insertCanonicalUser({ id: LOSER, email: "person@example.com", emailVerified: 0 });

    await mergeUsers(env.DB, { survivorId: SURVIVOR, loserId: LOSER });

    expect(await getUserRow(SURVIVOR)).toMatchObject({
      email: "person@example.com",
      email_verified: 0,
    });
  });

  it("previews all counts without writing in dry-run mode, with backfill parity", async () => {
    await insertCanonicalUser({ id: SURVIVOR, email: null });
    await insertCanonicalUser({ id: LOSER, email: "person@example.com", emailVerified: 1 });
    await insertIdentity({
      id: "i3111111111111111111111111111111",
      userId: LOSER,
      provider: "github",
      providerUserId: "583231",
      issuer: "https://github.com",
    });
    await insertSession("session-1", LOSER);

    const preview = await mergeUsers(env.DB, {
      survivorId: SURVIVOR,
      loserId: LOSER,
      dryRun: true,
    });

    expect(preview.dryRun).toBe(true);
    expect(preview.counts).toMatchObject({
      identitiesRepointed: 1,
      sessionsRepointed: 1,
      canonicalEmailBackfilled: 1,
      usersDeleted: 1,
    });
    // Nothing moved.
    expect(await getUserRow(LOSER)).not.toBeNull();
    expect(await getUserRow(SURVIVOR)).toMatchObject({ email: null });

    const executed = await mergeUsers(env.DB, { survivorId: SURVIVOR, loserId: LOSER });
    expect(executed.counts).toEqual(preview.counts);
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

  it("keeps preview and execution counts aligned for newer user-owned records", async () => {
    await insertCanonicalUser({ id: SURVIVOR, email: "person@example.com" });
    await insertCanonicalUser({ id: LOSER, email: null });
    const authorizationId = "c".repeat(64);
    const attemptId = "d".repeat(64);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO model_provider_account_authorizations (
             id, user_id, provider, operation, display_name, next_poll_at,
             expires_at, state, created_at, updated_at
           ) VALUES (?, ?, 'openai', 'create', 'Personal', ?, ?, 'initiating', ?, ?)`
      ).bind(authorizationId, LOSER, SEED_NOW_MS, SEED_NOW_MS + 60_000, SEED_NOW_MS, SEED_NOW_MS),
      env.DB.prepare(
        `INSERT INTO model_provider_account_authorization_attempts
             (id, user_id, attempted_at) VALUES (?, ?, ?)`
      ).bind(attemptId, LOSER, SEED_NOW_MS),
      env.DB.prepare(
        `INSERT INTO keyboard_shortcut_preferences (user_id, shortcuts, updated_at)
           VALUES (?, '{}', ?)`
      ).bind(LOSER, SEED_NOW_MS),
    ]);

    const preview = await mergeUsers(env.DB, {
      survivorId: SURVIVOR,
      loserId: LOSER,
      dryRun: true,
    });

    expect(preview.counts).toMatchObject({
      providerAccountAuthorizationsRepointed: 1,
      providerAccountAuthorizationAttemptsRepointed: 1,
      keyboardShortcutPreferencesDeduped: 0,
      keyboardShortcutPreferencesRepointed: 1,
    });
    expect(
      await env.DB.prepare(`SELECT user_id FROM model_provider_account_authorizations WHERE id = ?`)
        .bind(authorizationId)
        .first()
    ).toEqual({ user_id: LOSER });

    const result = await mergeUsers(env.DB, { survivorId: SURVIVOR, loserId: LOSER });

    expect(result.counts).toEqual(preview.counts);
    expect(
      await env.DB.prepare(`SELECT user_id FROM model_provider_account_authorizations WHERE id = ?`)
        .bind(authorizationId)
        .first()
    ).toEqual({ user_id: SURVIVOR });
    expect(
      await env.DB.prepare(
        `SELECT user_id FROM model_provider_account_authorization_attempts WHERE id = ?`
      )
        .bind(attemptId)
        .first()
    ).toEqual({ user_id: SURVIVOR });
    expect(
      await env.DB.prepare(`SELECT shortcuts FROM keyboard_shortcut_preferences WHERE user_id = ?`)
        .bind(SURVIVOR)
        .first()
    ).toEqual({ shortcuts: "{}" });
  });

  it("keeps keyboard preference collision preview and execution counts aligned", async () => {
    await insertCanonicalUser({ id: SURVIVOR, email: "person@example.com" });
    await insertCanonicalUser({ id: LOSER, email: null });
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO keyboard_shortcut_preferences (user_id, shortcuts, updated_at)
           VALUES (?, '{"survivor":true}', ?)`
      ).bind(SURVIVOR, SEED_NOW_MS),
      env.DB.prepare(
        `INSERT INTO keyboard_shortcut_preferences (user_id, shortcuts, updated_at)
           VALUES (?, '{"loser":true}', ?)`
      ).bind(LOSER, SEED_NOW_MS),
    ]);

    const preview = await mergeUsers(env.DB, {
      survivorId: SURVIVOR,
      loserId: LOSER,
      dryRun: true,
    });
    const result = await mergeUsers(env.DB, { survivorId: SURVIVOR, loserId: LOSER });

    expect(preview.counts.keyboardShortcutPreferencesDeduped).toBe(1);
    expect(preview.counts.keyboardShortcutPreferencesRepointed).toBe(0);
    expect(result.counts).toEqual(preview.counts);
    expect(
      await env.DB.prepare(`SELECT shortcuts FROM keyboard_shortcut_preferences WHERE user_id = ?`)
        .bind(SURVIVOR)
        .first()
    ).toEqual({ shortcuts: '{"survivor":true}' });
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
