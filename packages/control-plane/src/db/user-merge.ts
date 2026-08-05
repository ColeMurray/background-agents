import type { SqlDatabase, SqlStatement } from "./sql-database";

/**
 * Split-merge primitive: converge a loser canonical user's entire graph onto
 * a survivor. Splits arise when the canonical registry (bot ingress) and the
 * Better Auth registry attribute the same person to different rows — the R4
 * consistency report enumerates them; this merge resolves them.
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
 * - Idempotent: re-running a completed merge is a zero-count no-op.
 * - The loser's `auth_users` row is deleted (their sessions cascade — one
 *   sign-out; they land unified on the next sign-in); its accounts are
 *   re-created under the survivor, seeding the survivor's auth row from the
 *   loser's when the survivor has none.
 */

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
  /**
   * Email for the survivor's auth row when it inherits the loser's. Defaults
   * to the loser's auth email (the verified sign-in email keeps web auth
   * coherent). Appendix A leaves this per-case judgment, so it is a
   * parameter.
   */
  readonly survivingEmail?: string;
}

export interface UserMergeCounts {
  identitiesDeduped: number;
  identitiesRepointed: number;
  readStatesDeduped: number;
  readStatesRepointed: number;
  sessionsRepointed: number;
  automationsOwnedRepointed: number;
  automationsCreatedRepointed: number;
  scmTokensRepointed: number;
  authUsersDeleted: number;
  authUserCreatedForSurvivor: number;
  authAccountsMoved: number;
  canonicalEmailBackfilled: number;
  usersDeleted: number;
}

export interface UserMergeResult {
  readonly survivorId: string;
  readonly loserId: string;
  readonly dryRun: boolean;
  readonly counts: UserMergeCounts;
}

interface LoserAuthUserRow {
  id: string;
  name: string;
  email: string;
  emailVerified: number;
  image: string | null;
  createdAt: string;
  updatedAt: string;
}

interface LoserAuthAccountRow {
  id: string;
  accountId: string;
  providerId: string;
  accessToken: string | null;
  refreshToken: string | null;
  idToken: string | null;
  accessTokenExpiresAt: string | null;
  refreshTokenExpiresAt: string | null;
  scope: string | null;
  password: string | null;
  createdAt: string;
  updatedAt: string;
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
  const loserAuthUser = await db
    .prepare(
      `SELECT id, name, email, emailVerified, image, createdAt, updatedAt
       FROM auth_users WHERE id = ?`
    )
    .bind(loserId)
    .first<LoserAuthUserRow>();
  const survivorAuthUser = await db
    .prepare(`SELECT id FROM auth_users WHERE id = ?`)
    .bind(survivorId)
    .first<{ id: string }>();
  const loserAccounts = loserAuthUser
    ? (
        await db
          .prepare(
            `SELECT id, accountId, providerId, accessToken, refreshToken, idToken,
                    accessTokenExpiresAt, refreshTokenExpiresAt, scope, password,
                    createdAt, updatedAt
             FROM auth_accounts WHERE userId = ?`
          )
          .bind(loserId)
          .all<LoserAuthAccountRow>()
      ).results
    : [];

  const createAuthUserForSurvivor = Boolean(loserAuthUser) && !survivorAuthUser;
  const survivingEmail =
    options.survivingEmail?.trim().toLowerCase() || loserAuthUser?.email || null;

  if (options.dryRun) {
    return {
      survivorId,
      loserId,
      dryRun: true,
      counts: await previewCounts(db, survivorId, loserId, {
        authUsersDeleted: loserAuthUser ? 1 : 0,
        authUserCreatedForSurvivor: createAuthUserForSurvivor ? 1 : 0,
        authAccountsMoved: loserAccounts.length,
      }),
    };
  }

  const statements: SqlStatement[] = [];
  const track: Partial<Record<keyof UserMergeCounts, number>> = {};
  const add = (key: keyof UserMergeCounts, statement: SqlStatement) => {
    track[key] = statements.length;
    statements.push(statement);
  };

  // Dedup before re-pointing: drop loser rows whose target slot the survivor
  // already occupies (schema-impossible for identities today under
  // idx_user_identities_provider, but the rule is explicit; routine for read
  // states, where both split rows read the same session).
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

  if (loserAuthUser) {
    // Deleting the loser's auth user first frees its UNIQUE email for the
    // survivor's row and cascades the loser's accounts and sessions; the
    // accounts are then re-created under the survivor inside the same atomic
    // batch, so no interleaved sign-in can observe the gap.
    add("authUsersDeleted", db.prepare(`DELETE FROM auth_users WHERE id = ?`).bind(loserId));
    if (createAuthUserForSurvivor) {
      add(
        "authUserCreatedForSurvivor",
        db
          .prepare(
            `INSERT INTO auth_users (id, name, email, emailVerified, image, createdAt, updatedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            survivorId,
            loserAuthUser.name,
            survivingEmail,
            loserAuthUser.emailVerified,
            loserAuthUser.image,
            loserAuthUser.createdAt,
            new Date().toISOString()
          )
      );
    }
    for (const account of loserAccounts) {
      const statement = db
        .prepare(
          `INSERT INTO auth_accounts (
             id, accountId, providerId, userId, accessToken, refreshToken,
             idToken, accessTokenExpiresAt, refreshTokenExpiresAt, scope,
             password, createdAt, updatedAt
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          account.id,
          account.accountId,
          account.providerId,
          survivorId,
          account.accessToken,
          account.refreshToken,
          account.idToken,
          account.accessTokenExpiresAt,
          account.refreshTokenExpiresAt,
          account.scope,
          account.password,
          account.createdAt,
          account.updatedAt
        );
      if (track.authAccountsMoved === undefined) {
        track.authAccountsMoved = statements.length;
      }
      statements.push(statement);
    }
  }

  add("usersDeleted", db.prepare(`DELETE FROM users WHERE id = ?`).bind(loserId));
  if (survivingEmail && !survivor.email) {
    // A NULL-email survivor (GitHub-first bot row) acquires the verified
    // email freed by the loser's deletion, guarded against any other owner.
    add(
      "canonicalEmailBackfilled",
      db
        .prepare(
          `UPDATE users SET email = ?, updated_at = ?
           WHERE id = ?
             AND email IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM users AS other
               WHERE other.id <> users.id AND lower(trim(other.email)) = ?
             )`
        )
        .bind(survivingEmail, Date.now(), survivorId, survivingEmail)
    );
  }

  const results = await db.batch(statements);

  const counts = emptyCounts();
  for (const [key, index] of Object.entries(track) as [keyof UserMergeCounts, number][]) {
    counts[key] = results[index]?.meta.changes ?? 0;
  }
  if (loserAuthUser) {
    // The auth-user delete's reported `changes` includes cascaded account and
    // session rows; the row counts here are known exactly from the preload.
    counts.authUsersDeleted = 1;
    counts.authAccountsMoved = loserAccounts.length;
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
    automationsOwnedRepointed: 0,
    automationsCreatedRepointed: 0,
    scmTokensRepointed: 0,
    authUsersDeleted: 0,
    authUserCreatedForSurvivor: 0,
    authAccountsMoved: 0,
    canonicalEmailBackfilled: 0,
    usersDeleted: 0,
  };
}

async function previewCounts(
  db: SqlDatabase,
  survivorId: string,
  loserId: string,
  authCounts: Pick<
    UserMergeCounts,
    "authUsersDeleted" | "authUserCreatedForSurvivor" | "authAccountsMoved"
  >
): Promise<UserMergeCounts> {
  const [
    identitiesDeduped,
    identities,
    readStatesDeduped,
    readStates,
    sessions,
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
    db.prepare(`SELECT COUNT(*) AS count FROM automations WHERE user_id = ?`).bind(loserId),
    db.prepare(`SELECT COUNT(*) AS count FROM automations WHERE created_by = ?`).bind(loserId),
    db.prepare(`SELECT COUNT(*) AS count FROM user_scm_tokens WHERE user_id = ?`).bind(loserId),
    db.prepare(`SELECT COUNT(*) AS count FROM users WHERE id = ?`).bind(loserId),
  ]);

  const count = (result: { results: { count: number }[] }) => result.results[0]?.count ?? 0;
  return {
    ...emptyCounts(),
    ...authCounts,
    identitiesDeduped: count(identitiesDeduped),
    identitiesRepointed: count(identities) - count(identitiesDeduped),
    readStatesDeduped: count(readStatesDeduped),
    readStatesRepointed: count(readStates) - count(readStatesDeduped),
    sessionsRepointed: count(sessions),
    automationsOwnedRepointed: count(automationsOwned),
    automationsCreatedRepointed: count(automationsCreated),
    scmTokensRepointed: count(scmTokens),
    usersDeleted: count(users),
  };
}
