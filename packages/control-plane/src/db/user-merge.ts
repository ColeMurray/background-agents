import type { SqlDatabase, SqlResult, SqlStatement } from "./sql-database";
import { GuardedWriteConflictError, runGuardedBatch, type GuardedWrite } from "./guarded-write";

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

const USER_MERGE_COUNT_KEYS = [
  "identitiesDeduped",
  "identitiesRepointed",
  "readStatesDeduped",
  "readStatesRepointed",
  "sessionsRepointed",
  "authSessionsRepointed",
  "automationsOwnedRepointed",
  "automationsCreatedRepointed",
  "scmTokensRepointed",
  "skillProfileItemsMerged",
  "skillProfilesDeduped",
  "skillProfilesRepointed",
  "roleAssignmentsRemoved",
  "sessionAccessCollisionsUpdated",
  "sessionAccessDeduped",
  "sessionAccessRepointed",
  "providerAccountAuthorizationsRepointed",
  "providerAccountAuthorizationAttemptsRepointed",
  "keyboardShortcutPreferencesDeduped",
  "keyboardShortcutPreferencesRepointed",
  "auditEventsCreated",
  "canonicalEmailBackfilled",
  "usersDeleted",
] as const;

type UserMergeCountKey = (typeof USER_MERGE_COUNT_KEYS)[number];
type UserMergeCounts = Record<UserMergeCountKey, number>;

interface MergeOperation {
  readonly key: UserMergeCountKey;
  readonly execute: (db: SqlDatabase, survivorId: string, loserId: string) => SqlStatement;
  readonly preview: (db: SqlDatabase, survivorId: string, loserId: string) => SqlStatement;
  readonly subtract?: UserMergeCountKey;
}

function regularRepoint(key: UserMergeCountKey, table: string, column = "user_id"): MergeOperation {
  return {
    key,
    execute: (db, survivorId, loserId) =>
      db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`).bind(survivorId, loserId),
    preview: (db, _survivorId, loserId) =>
      db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`).bind(loserId),
  };
}

function dedupeThenRepoint(options: {
  readonly dedupeKey: UserMergeCountKey;
  readonly repointKey: UserMergeCountKey;
  readonly table: string;
  readonly collision: string;
}): readonly [MergeOperation, MergeOperation] {
  return [
    {
      key: options.dedupeKey,
      execute: (db, survivorId, loserId) =>
        db
          .prepare(`DELETE FROM ${options.table} WHERE user_id = ? AND ${options.collision}`)
          .bind(loserId, survivorId),
      preview: (db, survivorId, loserId) =>
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM ${options.table}
             WHERE user_id = ? AND ${options.collision}`
          )
          .bind(loserId, survivorId),
    },
    {
      ...regularRepoint(options.repointKey, options.table),
      subtract: options.dedupeKey,
    },
  ];
}

const BEFORE_SKILL_PROFILE_OPERATIONS = [
  ...dedupeThenRepoint({
    dedupeKey: "identitiesDeduped",
    repointKey: "identitiesRepointed",
    table: "user_identities",
    collision: `EXISTS (
      SELECT 1 FROM user_identities AS survivor_identity
      WHERE survivor_identity.user_id = ?
        AND survivor_identity.provider = user_identities.provider
        AND survivor_identity.provider_user_id = user_identities.provider_user_id
    )`,
  }),
  ...dedupeThenRepoint({
    dedupeKey: "readStatesDeduped",
    repointKey: "readStatesRepointed",
    table: "session_read_states",
    collision: `EXISTS (
      SELECT 1 FROM session_read_states AS survivor_state
      WHERE survivor_state.user_id = ?
        AND survivor_state.session_id = session_read_states.session_id
    )`,
  }),
  regularRepoint("sessionsRepointed", "sessions"),
  regularRepoint("authSessionsRepointed", "auth_sessions", "userId"),
  regularRepoint("automationsOwnedRepointed", "automations"),
  regularRepoint("automationsCreatedRepointed", "automations", "created_by"),
  regularRepoint("scmTokensRepointed", "user_scm_tokens"),
] as const satisfies readonly MergeOperation[];

const SKILL_PROFILE_OPERATIONS = dedupeThenRepoint({
  dedupeKey: "skillProfilesDeduped",
  repointKey: "skillProfilesRepointed",
  table: "skill_profiles",
  collision: `EXISTS (
    SELECT 1 FROM skill_profiles survivor_profile
    WHERE survivor_profile.user_id = ? AND survivor_profile.name = skill_profiles.name
  )`,
});

const SESSION_ACCESS_OPERATIONS = dedupeThenRepoint({
  dedupeKey: "sessionAccessDeduped",
  repointKey: "sessionAccessRepointed",
  table: "session_access",
  collision: `EXISTS (
    SELECT 1 FROM session_access survivor_access
    WHERE survivor_access.user_id = ?
      AND survivor_access.session_id = session_access.session_id
  )`,
});

const FINAL_REPOINT_OPERATIONS = [
  regularRepoint("providerAccountAuthorizationsRepointed", "model_provider_account_authorizations"),
  regularRepoint(
    "providerAccountAuthorizationAttemptsRepointed",
    "model_provider_account_authorization_attempts"
  ),
  ...dedupeThenRepoint({
    dedupeKey: "keyboardShortcutPreferencesDeduped",
    repointKey: "keyboardShortcutPreferencesRepointed",
    table: "keyboard_shortcut_preferences",
    collision: `EXISTS (SELECT 1 FROM keyboard_shortcut_preferences WHERE user_id = ?)`,
  }),
] as const satisfies readonly MergeOperation[];

const TABLE_OPERATIONS = [
  ...BEFORE_SKILL_PROFILE_OPERATIONS,
  ...SKILL_PROFILE_OPERATIONS,
  ...SESSION_ACCESS_OPERATIONS,
  ...FINAL_REPOINT_OPERATIONS,
] as const;

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
    .prepare(`SELECT id, email, suspended_at FROM users WHERE id = ?`)
    .bind(survivorId)
    .first<{
      id: string;
      email: string | null;
      suspended_at: number | null;
    }>();
  if (!survivor) {
    throw new UserMergeError(`Survivor user ${survivorId} not found`);
  }
  // A missing loser row is not an error: re-running a completed merge must
  // be a no-op, and a partially-applied merge must be resumable.
  const loser = await db
    .prepare(`SELECT id, email, email_verified FROM users WHERE id = ?`)
    .bind(loserId)
    .first<{
      id: string;
      email: string | null;
      email_verified: number;
    }>();
  if (!loser) {
    return { survivorId, loserId, dryRun: options.dryRun === true, counts: emptyCounts() };
  }

  const survivorEmail = normalizeEmail(survivor.email);
  const loserEmail = normalizeEmail(loser?.email);
  const [survivorAssignment, loserAssignment] = await db.batch<{
    role_id: string;
    role_key: string | null;
  }>([
    db
      .prepare(
        `SELECT ura.role_id, r.key AS role_key FROM user_role_assignments ura
         JOIN roles r ON r.id = ura.role_id WHERE ura.user_id = ?`
      )
      .bind(survivorId),
    db
      .prepare(
        `SELECT ura.role_id, r.key AS role_key FROM user_role_assignments ura
         JOIN roles r ON r.id = ura.role_id WHERE ura.user_id = ?`
      )
      .bind(loserId),
  ]);
  const survivorRole = survivorAssignment.results[0];
  const loserRole = loserAssignment.results[0];
  if (!survivorRole || !loserRole) {
    throw new UserMergeError("Both users must have explicit role assignments before merging");
  }
  if (survivorRole && loserRole && survivorRole.role_id !== loserRole.role_id) {
    throw new UserMergeError("Resolve conflicting user roles before merging");
  }
  if (loserRole?.role_key === "owner" && survivor.suspended_at !== null) {
    throw new UserMergeError("The surviving Owner must be active before merging");
  }
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

  const mergeGuard: GuardedWrite = {
    name: "user_merge_state",
    predicate: {
      sql: `EXISTS (
          SELECT 1 FROM users u
          JOIN user_role_assignments ura ON ura.user_id = u.id
          WHERE u.id = ? AND u.suspended_at IS ? AND ura.role_id = ?
        )
        AND EXISTS (
          SELECT 1 FROM users u
          JOIN user_role_assignments ura ON ura.user_id = u.id
          WHERE u.id = ? AND ura.role_id = ?
        )`,
      values: [survivorId, survivor.suspended_at, survivorRole.role_id, loserId, loserRole.role_id],
    },
  };
  const statements: SqlStatement[] = [];
  const track: Partial<Record<UserMergeCountKey, number>> = {};
  const add = (key: UserMergeCountKey, statement: SqlStatement) => {
    track[key] = statements.length;
    statements.push(statement);
  };
  const addOperations = (operations: readonly MergeOperation[]) => {
    for (const operation of operations) {
      add(operation.key, operation.execute(db, survivorId, loserId));
    }
  };

  // Dedup before re-pointing: drop loser rows whose target slot the survivor
  // already occupies (identities under idx_user_identities_provider; read
  // states routinely, where both split rows read the same session).
  addOperations(BEFORE_SKILL_PROFILE_OPERATIONS);

  // Merge items before deleting colliding skill profiles.
  add(
    "skillProfileItemsMerged",
    db
      .prepare(
        `INSERT OR IGNORE INTO skill_profile_items (profile_id, skill_id)
         SELECT survivor_profile.id, loser_item.skill_id
         FROM skill_profiles loser_profile
         JOIN skill_profiles survivor_profile
           ON survivor_profile.user_id = ? AND survivor_profile.name = loser_profile.name
         JOIN skill_profile_items loser_item ON loser_item.profile_id = loser_profile.id
         WHERE loser_profile.user_id = ?`
      )
      .bind(survivorId, loserId)
  );
  addOperations(SKILL_PROFILE_OPERATIONS);

  // Preserve RBAC and session-access invariants before deleting the loser.
  add(
    "roleAssignmentsRemoved",
    db.prepare("DELETE FROM user_role_assignments WHERE user_id = ?").bind(loserId)
  );
  add(
    "sessionAccessCollisionsUpdated",
    db
      .prepare(
        `UPDATE session_access AS survivor_access
         SET relation = 'creator'
         WHERE survivor_access.user_id = ?
           AND survivor_access.relation = 'participant'
           AND EXISTS (
             SELECT 1 FROM session_access AS loser_access
             WHERE loser_access.user_id = ?
               AND loser_access.session_id = survivor_access.session_id
               AND loser_access.relation = 'creator'
           )`
      )
      .bind(survivorId, loserId)
  );
  addOperations(SESSION_ACCESS_OPERATIONS);
  addOperations(FINAL_REPOINT_OPERATIONS);

  // Record the merge before deleting the user so the snapshots remain explicit.
  add(
    "auditEventsCreated",
    db
      .prepare(
        `INSERT INTO authorization_audit_events
            (id, occurred_at, request_id, principal_kind,
             actor_service_snapshot, action, resource_type, resource_id,
             target_user_id_snapshot, reason_code)
           VALUES (?, ?, 'user-merge', 'service', 'control-plane',
                   'workspace.user_merged', 'user', ?, ?, 'operator_merge')`
      )
      .bind(crypto.randomUUID(), Date.now(), survivorId, loserId)
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

  let results: SqlResult[];
  try {
    results = await runGuardedBatch(db, [mergeGuard], statements);
  } catch (cause) {
    if (cause instanceof GuardedWriteConflictError) {
      throw new UserMergeError("User role or status changed during merge");
    }
    throw cause;
  }

  const counts = emptyCounts();
  for (const [key, index] of Object.entries(track) as [UserMergeCountKey, number][]) {
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
  return Object.fromEntries(USER_MERGE_COUNT_KEYS.map((key) => [key, 0])) as UserMergeCounts;
}

async function previewCounts(
  db: SqlDatabase,
  survivorId: string,
  loserId: string,
  backfillEmail: string | null
): Promise<UserMergeCounts> {
  const operationResults = await db.batch<{ count: number }>(
    TABLE_OPERATIONS.map((operation) => operation.preview(db, survivorId, loserId))
  );
  const operationCounts = emptyCounts();
  for (const [index, operation] of TABLE_OPERATIONS.entries()) {
    const total = operationResults[index]?.results[0]?.count ?? 0;
    operationCounts[operation.key] =
      total - (operation.subtract ? operationCounts[operation.subtract] : 0);
  }

  const [skillProfileItemsMerged, roleAssignments, sessionAccessCollisionsUpdated, users] =
    await db.batch<{ count: number }>([
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM skill_profile_items loser_item
         JOIN skill_profiles loser_profile ON loser_profile.id = loser_item.profile_id
         JOIN skill_profiles survivor_profile
           ON survivor_profile.user_id = ? AND survivor_profile.name = loser_profile.name
         WHERE loser_profile.user_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM skill_profile_items survivor_item
             WHERE survivor_item.profile_id = survivor_profile.id
               AND survivor_item.skill_id = loser_item.skill_id
           )`
        )
        .bind(survivorId, loserId),
      db
        .prepare(`SELECT COUNT(*) AS count FROM user_role_assignments WHERE user_id = ?`)
        .bind(loserId),
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM session_access AS survivor_access
         WHERE survivor_access.user_id = ?
           AND survivor_access.relation = 'participant'
           AND EXISTS (
             SELECT 1 FROM session_access AS loser_access
             WHERE loser_access.user_id = ?
               AND loser_access.session_id = survivor_access.session_id
               AND loser_access.relation = 'creator'
           )`
        )
        .bind(survivorId, loserId),
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
    ...operationCounts,
    skillProfileItemsMerged: count(skillProfileItemsMerged),
    roleAssignmentsRemoved: count(roleAssignments),
    sessionAccessCollisionsUpdated: count(sessionAccessCollisionsUpdated),
    auditEventsCreated: count(users),
    canonicalEmailBackfilled,
    usersDeleted: count(users),
  };
}
