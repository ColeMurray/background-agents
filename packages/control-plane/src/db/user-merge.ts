import type { SqlDatabase, SqlStatement } from "./sql-database";

/**
 * Split-merge primitive: converge a loser canonical user's entire graph onto
 * a survivor. Splits arise when two canonical rows turn out to be the same
 * person (e.g. a Slack-attributed email beside a GitHub-subject row —
 * `auth.subject_email_collision` enumerates the live cases).
 *
 * Deliberately a library + operator script, not an HTTP endpoint: a merge
 * primitive on an authenticated surface adds authz/abuse surface for no
 * safety gain.
 *
 * Guarantees:
 * - Dry-run by default in the CLI wrapper; `mergeUsers` itself takes an
 *   explicit `dryRun` flag and previews exact per-table counts.
 * - The execute path is a single atomic batch ordered to satisfy every
 *   foreign key at each step, with explicit dedup rules for
 *   `session_read_states` (survivor's row wins on a `(user_id, session_id)`
 *   collision) and `user_identities` (survivor's row wins under
 *   `idx_user_identities_provider`).
 * - `automations.created_by` is re-pointed value-conditionally: legacy rows
 *   store GitHub numeric ids, which must never be rewritten.
 * - Idempotent: re-running a completed merge is a zero-count no-op, and a
 *   partially-applied run is repaired by running the script again — with one
 *   exception: the final email backfill's input (the loser row) is deleted by
 *   the preceding statement, so a stop exactly between those two statements
 *   is not re-derivable from the database. The CLI prints a recovery record
 *   before executing to cover that residual case.
 * - Browser sessions (`auth_sessions`) are re-pointed, not deleted — the
 *   merged person stays signed in as the survivor.
 * - Verification never transfers to an unproven address: the loser's email
 *   (and its `email_verified` flag) backfills the survivor only when the
 *   survivor has no email of its own.
 */

/**
 * Mirror of `./email`'s normalizeEmail: this module is imported by the
 * operator CLI under Node's type-stripping loader, which cannot resolve
 * extensionless runtime imports — so it must stay free of value imports.
 * Keep byte-identical to `./email` and to the SQL `lower(trim(...))` rule.
 */
function normalizeEmail(email: string | null | undefined): string | null {
  const normalized = email?.trim().toLowerCase();
  return normalized ? normalized : null;
}

export class UserMergeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserMergeError";
  }
}

export interface UserMergeOptions {
  readonly survivorId: string;
  readonly loserId: string;
  readonly dryRun?: boolean;
}

export interface UserMergeCounts {
  identitiesDeduped: number;
  identitiesRepointed: number;
  readStatesDeduped: number;
  readStatesRepointed: number;
  sessionsRepointed: number;
  authSessionsRepointed: number;
  automationsOwnedRepointed: number;
  automationsCreatedRepointed: number;
  scmTokensRepointed: number;
  canonicalEmailBackfilled: number;
  usersDeleted: number;
}

export interface UserMergeResult {
  readonly survivorId: string;
  readonly loserId: string;
  readonly dryRun: boolean;
  readonly counts: UserMergeCounts;
}

export async function mergeUsers(
  db: SqlDatabase,
  options: UserMergeOptions
): Promise<UserMergeResult> {
  const { survivorId, loserId } = options;
  if (survivorId === loserId) {
    throw new UserMergeError("Survivor and loser must be different users");
  }
  const survivor = await db
    .prepare(`SELECT id, email FROM users WHERE id = ?`)
    .bind(survivorId)
    .first<{ id: string; email: string | null }>();
  if (!survivor) {
    throw new UserMergeError(`Survivor user ${survivorId} not found`);
  }
  // A missing loser row is not an error: re-running a completed merge must
  // be a no-op, and a partially-applied merge must be resumable.
  const loser = await db
    .prepare(`SELECT id, email, email_verified FROM users WHERE id = ?`)
    .bind(loserId)
    .first<{ id: string; email: string | null; email_verified: number }>();

  const survivorEmail = normalizeEmail(survivor.email);
  const loserEmail = normalizeEmail(loser?.email);
  // The loser's email backfills an email-less survivor after the loser row's
  // deletion frees the unique slot; its verification state carries with it.
  const backfillEmail = !survivorEmail && loserEmail ? loserEmail : null;
  const backfillVerified = backfillEmail ? (loser?.email_verified ?? 0) : 0;

  if (options.dryRun) {
    return {
      survivorId,
      loserId,
      dryRun: true,
      counts: await previewCounts(db, survivorId, loserId, backfillEmail),
    };
  }

  const statements: SqlStatement[] = [];
  const track: Partial<Record<keyof UserMergeCounts, number>> = {};
  const add = (key: keyof UserMergeCounts, statement: SqlStatement) => {
    track[key] = statements.length;
    statements.push(statement);
  };

  // Dedup before re-pointing: drop loser rows whose target slot the survivor
  // already occupies (identities under idx_user_identities_provider; read
  // states routinely, where both split rows read the same session).
  add(
    "identitiesDeduped",
    db
      .prepare(
        `DELETE FROM user_identities
         WHERE user_id = ?
           AND EXISTS (
             SELECT 1 FROM user_identities AS survivor_identity
             WHERE survivor_identity.user_id = ?
               AND survivor_identity.provider = user_identities.provider
               AND survivor_identity.provider_user_id = user_identities.provider_user_id
           )`
      )
      .bind(loserId, survivorId)
  );
  add(
    "identitiesRepointed",
    db.prepare(`UPDATE user_identities SET user_id = ? WHERE user_id = ?`).bind(survivorId, loserId)
  );
  add(
    "readStatesDeduped",
    db
      .prepare(
        `DELETE FROM session_read_states
         WHERE user_id = ?
           AND EXISTS (
             SELECT 1 FROM session_read_states AS survivor_state
             WHERE survivor_state.user_id = ?
               AND survivor_state.session_id = session_read_states.session_id
           )`
      )
      .bind(loserId, survivorId)
  );
  add(
    "readStatesRepointed",
    db
      .prepare(`UPDATE session_read_states SET user_id = ? WHERE user_id = ?`)
      .bind(survivorId, loserId)
  );
  add(
    "sessionsRepointed",
    db.prepare(`UPDATE sessions SET user_id = ? WHERE user_id = ?`).bind(survivorId, loserId)
  );
  // Browser sessions re-point (FK → users): the person stays signed in and
  // is simply the survivor from the next request on.
  add(
    "authSessionsRepointed",
    db.prepare(`UPDATE auth_sessions SET userId = ? WHERE userId = ?`).bind(survivorId, loserId)
  );
  add(
    "automationsOwnedRepointed",
    db.prepare(`UPDATE automations SET user_id = ? WHERE user_id = ?`).bind(survivorId, loserId)
  );
  // Value-conditional: created_by is compared for exact equality with the
  // loser's canonical id, so legacy GitHub numeric ids pass through.
  add(
    "automationsCreatedRepointed",
    db
      .prepare(`UPDATE automations SET created_by = ? WHERE created_by = ?`)
      .bind(survivorId, loserId)
  );
  add(
    "scmTokensRepointed",
    db.prepare(`UPDATE user_scm_tokens SET user_id = ? WHERE user_id = ?`).bind(survivorId, loserId)
  );

  add("usersDeleted", db.prepare(`DELETE FROM users WHERE id = ?`).bind(loserId));
  if (backfillEmail) {
    // A blank-or-NULL-email survivor acquires the email freed by the loser's
    // deletion, guarded against any other owner. Verification carries only
    // as-was — never upgraded by a merge.
    add(
      "canonicalEmailBackfilled",
      db
        .prepare(
          `UPDATE users SET email = ?, email_verified = ?, updated_at = ?
           WHERE id = ?
             AND (email IS NULL OR length(trim(email)) = 0)
             AND NOT EXISTS (
               SELECT 1 FROM users AS other
               WHERE other.id <> users.id AND lower(trim(other.email)) = ?
             )`
        )
        .bind(backfillEmail, backfillVerified, Date.now(), survivorId, backfillEmail)
    );
  }

  const results = await db.batch(statements);

  const counts = emptyCounts();
  for (const [key, index] of Object.entries(track) as [keyof UserMergeCounts, number][]) {
    counts[key] = results[index]?.meta.changes ?? 0;
  }
  if (loser) {
    // The users delete's reported `changes` includes any FK-cascaded rows;
    // the row count here is known exactly from the preload.
    counts.usersDeleted = 1;
  }
  return { survivorId, loserId, dryRun: false, counts };
}

function emptyCounts(): UserMergeCounts {
  return {
    identitiesDeduped: 0,
    identitiesRepointed: 0,
    readStatesDeduped: 0,
    readStatesRepointed: 0,
    sessionsRepointed: 0,
    authSessionsRepointed: 0,
    automationsOwnedRepointed: 0,
    automationsCreatedRepointed: 0,
    scmTokensRepointed: 0,
    canonicalEmailBackfilled: 0,
    usersDeleted: 0,
  };
}

async function previewCounts(
  db: SqlDatabase,
  survivorId: string,
  loserId: string,
  backfillEmail: string | null
): Promise<UserMergeCounts> {
  const [
    identitiesDeduped,
    identities,
    readStatesDeduped,
    readStates,
    sessions,
    authSessions,
    automationsOwned,
    automationsCreated,
    scmTokens,
    users,
  ] = await db.batch<{ count: number }>([
    db
      .prepare(
        `SELECT COUNT(*) AS count FROM user_identities
         WHERE user_id = ?
           AND EXISTS (
             SELECT 1 FROM user_identities AS survivor_identity
             WHERE survivor_identity.user_id = ?
               AND survivor_identity.provider = user_identities.provider
               AND survivor_identity.provider_user_id = user_identities.provider_user_id
           )`
      )
      .bind(loserId, survivorId),
    db.prepare(`SELECT COUNT(*) AS count FROM user_identities WHERE user_id = ?`).bind(loserId),
    db
      .prepare(
        `SELECT COUNT(*) AS count FROM session_read_states
         WHERE user_id = ?
           AND EXISTS (
             SELECT 1 FROM session_read_states AS survivor_state
             WHERE survivor_state.user_id = ?
               AND survivor_state.session_id = session_read_states.session_id
           )`
      )
      .bind(loserId, survivorId),
    db.prepare(`SELECT COUNT(*) AS count FROM session_read_states WHERE user_id = ?`).bind(loserId),
    db.prepare(`SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?`).bind(loserId),
    db.prepare(`SELECT COUNT(*) AS count FROM auth_sessions WHERE userId = ?`).bind(loserId),
    db.prepare(`SELECT COUNT(*) AS count FROM automations WHERE user_id = ?`).bind(loserId),
    db.prepare(`SELECT COUNT(*) AS count FROM automations WHERE created_by = ?`).bind(loserId),
    db.prepare(`SELECT COUNT(*) AS count FROM user_scm_tokens WHERE user_id = ?`).bind(loserId),
    db.prepare(`SELECT COUNT(*) AS count FROM users WHERE id = ?`).bind(loserId),
  ]);

  const count = (result: { results: { count: number }[] }) => result.results[0]?.count ?? 0;

  // Dry-run parity for the canonical-email backfill: it fires when the
  // survivor has no canonical email and no third user owns the target.
  let canonicalEmailBackfilled = 0;
  if (backfillEmail) {
    const otherOwner = await db
      .prepare(
        `SELECT COUNT(*) AS count FROM users
         WHERE id NOT IN (?, ?) AND lower(trim(email)) = ?`
      )
      .bind(survivorId, loserId, backfillEmail)
      .first<{ count: number }>();
    canonicalEmailBackfilled = (otherOwner?.count ?? 0) === 0 ? 1 : 0;
  }

  return {
    ...emptyCounts(),
    identitiesDeduped: count(identitiesDeduped),
    identitiesRepointed: count(identities) - count(identitiesDeduped),
    readStatesDeduped: count(readStatesDeduped),
    readStatesRepointed: count(readStates) - count(readStatesDeduped),
    sessionsRepointed: count(sessions),
    authSessionsRepointed: count(authSessions),
    automationsOwnedRepointed: count(automationsOwned),
    automationsCreatedRepointed: count(automationsCreated),
    scmTokensRepointed: count(scmTokens),
    canonicalEmailBackfilled,
    usersDeleted: count(users),
  };
}
