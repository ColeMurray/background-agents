import type { SqlDatabase, SqlResult, SqlStatement } from "./sql-database";

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
 * - Idempotent: re-running a completed merge is a zero-count no-op. The
 *   execute path requires an atomic SqlDatabase batch so no partial graph can
 *   become externally visible.
 * - Browser sessions (`auth_sessions`) issued to the loser are deleted. An
 *   issued bearer credential is never rewritten to authenticate as another
 *   canonical user.
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
  "authSessionsDeleted",
  "automationsOwnedRepointed",
  "automationsCreatedRepointed",
  "scmTokensRepointed",
  "skillProfileItemsMerged",
  "skillProfilesDeduped",
  "skillProfilesRepointed",
  "roleAssignmentsRemoved",
  "providerAccountAuthorizationsRepointed",
  "providerAccountAuthorizationAttemptsRepointed",
  "providerAccountsCreatedRepointed",
  "providerAccountsUpdatedRepointed",
  "providerAccountDefaultsCreatedRepointed",
  "providerAccountDefaultsUpdatedRepointed",
  "skillsCreatedRepointed",
  "skillsUpdatedRepointed",
  "skillRevisionsCreatedRepointed",
  "skillAssignmentsCreatedRepointed",
  "skillCatalogGenerationsAdvanced",
  "keyboardShortcutPreferencesDeduped",
  "keyboardShortcutPreferencesRepointed",
  "auditEventsCreated",
  "canonicalEmailBackfilled",
  "usersDeleted",
] as const;

type UserMergeCountKey = (typeof USER_MERGE_COUNT_KEYS)[number];
type UserMergeCounts = Record<UserMergeCountKey, number>;

const RESULT_CHANGE_DIVISORS: Partial<Record<UserMergeCountKey, number>> = {
  // The assignment UPDATE trigger also advances skills_catalog_state once per
  // changed assignment, and D1 includes both rows in meta.changes.
  skillAssignmentsCreatedRepointed: 2,
};

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

function regularDelete(key: UserMergeCountKey, table: string, column = "user_id"): MergeOperation {
  return {
    key,
    execute: (db, _survivorId, loserId) =>
      db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).bind(loserId),
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
  regularDelete("authSessionsDeleted", "auth_sessions", "userId"),
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

const SKILL_CATALOG_GENERATION_OPERATION: MergeOperation = {
  key: "skillCatalogGenerationsAdvanced",
  execute: (db, _survivorId, loserId) =>
    db
      .prepare(
        `UPDATE skills_catalog_state SET generation = generation + 1
         WHERE singleton = 1
           AND EXISTS (SELECT 1 FROM skill_profiles WHERE user_id = ?)`
      )
      .bind(loserId),
  preview: (db, _survivorId, loserId) =>
    db
      .prepare(
        `SELECT COUNT(*) AS count FROM skills_catalog_state
         WHERE singleton = 1
           AND EXISTS (SELECT 1 FROM skill_profiles WHERE user_id = ?)`
      )
      .bind(loserId),
};

const FINAL_REPOINT_OPERATIONS = [
  regularRepoint("providerAccountAuthorizationsRepointed", "model_provider_account_authorizations"),
  regularRepoint(
    "providerAccountAuthorizationAttemptsRepointed",
    "model_provider_account_authorization_attempts"
  ),
  regularRepoint("providerAccountsCreatedRepointed", "model_provider_accounts", "created_by"),
  regularRepoint("providerAccountsUpdatedRepointed", "model_provider_accounts", "updated_by"),
  regularRepoint(
    "providerAccountDefaultsCreatedRepointed",
    "model_provider_account_defaults",
    "created_by"
  ),
  regularRepoint(
    "providerAccountDefaultsUpdatedRepointed",
    "model_provider_account_defaults",
    "updated_by"
  ),
  regularRepoint("skillsCreatedRepointed", "skills", "created_by"),
  regularRepoint("skillsUpdatedRepointed", "skills", "updated_by"),
  regularRepoint("skillRevisionsCreatedRepointed", "skill_revisions", "created_by"),
  regularRepoint("skillAssignmentsCreatedRepointed", "skill_assignments", "created_by"),
  ...dedupeThenRepoint({
    dedupeKey: "keyboardShortcutPreferencesDeduped",
    repointKey: "keyboardShortcutPreferencesRepointed",
    table: "keyboard_shortcut_preferences",
    collision: `EXISTS (SELECT 1 FROM keyboard_shortcut_preferences WHERE user_id = ?)`,
  }),
] as const satisfies readonly MergeOperation[];

const TABLE_OPERATIONS = [
  ...BEFORE_SKILL_PROFILE_OPERATIONS,
  SKILL_CATALOG_GENERATION_OPERATION,
  ...SKILL_PROFILE_OPERATIONS,
  ...FINAL_REPOINT_OPERATIONS,
] as const;

/** Counts and identities produced by a user merge or dry-run preview. */
export interface UserMergeResult {
  readonly survivorId: string;
  readonly loserId: string;
  readonly dryRun: boolean;
  readonly counts: UserMergeCounts;
}

/**
 * Merge a canonical user into a survivor after validating their RBAC assignments.
 */
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
  // be a no-op after an already-completed atomic merge.
  const loser = await db
    .prepare(`SELECT id, email, email_verified, suspended_at FROM users WHERE id = ?`)
    .bind(loserId)
    .first<{
      id: string;
      email: string | null;
      email_verified: number;
      suspended_at: number | null;
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
  if ((survivor.suspended_at === null) !== (loser.suspended_at === null)) {
    throw new UserMergeError("Resolve conflicting user suspension states before merging");
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

  const auditId = crypto.randomUUID();
  const occurredAt = Date.now();
  // The NOT NULL occurred_at column turns a failed revalidation into a batch
  // error, rolling back every merge write. This closes the preflight/write
  // window for role, suspension, and last-active-Owner invariants.
  add(
    "auditEventsCreated",
    db
      .prepare(
        `INSERT INTO authorization_audit_events
            (id, occurred_at, request_id, principal_kind,
             actor_service_snapshot, action, resource_type, resource_id,
             target_user_id_snapshot, reason_code, operation_result, metadata_json)
         VALUES (
           ?,
           CASE WHEN EXISTS (
             SELECT 1
             FROM users survivor
             JOIN user_role_assignments survivor_assignment
               ON survivor_assignment.user_id = survivor.id
             JOIN users loser ON loser.id = ?
             JOIN user_role_assignments loser_assignment
               ON loser_assignment.user_id = loser.id
             JOIN roles role ON role.id = loser_assignment.role_id
             WHERE survivor.id = ?
               AND survivor_assignment.role_id = loser_assignment.role_id
               AND (survivor.suspended_at IS NULL) = (loser.suspended_at IS NULL)
               AND (role.key IS NULL OR role.key <> 'owner' OR survivor.suspended_at IS NULL)
           ) THEN ? ELSE NULL END,
            'operator-cli:' || ?, 'service', 'operator-cli',
            'workspace.user_merged', 'user', ?, ?, 'operator_merge', 'applied',
            json_object(
              'before', json_object(
                'survivor', json_object(
                  'userId', ?,
                  'roleId', (SELECT role_id FROM user_role_assignments WHERE user_id = ?),
                  'suspendedAt', (SELECT suspended_at FROM users WHERE id = ?)
                ),
                'loser', json_object(
                  'userId', ?,
                  'roleId', (SELECT role_id FROM user_role_assignments WHERE user_id = ?),
                  'suspendedAt', (SELECT suspended_at FROM users WHERE id = ?)
                )
              ),
              'requested', json_object('survivorUserId', ?, 'loserUserId', ?),
              'after', json_object(
                'survivor', json_object(
                  'userId', ?,
                  'roleId', (SELECT role_id FROM user_role_assignments WHERE user_id = ?),
                  'suspendedAt', (SELECT suspended_at FROM users WHERE id = ?)
                ),
                'loser', NULL
              )
            )
          )`
      )
      .bind(
        auditId,
        loserId,
        survivorId,
        occurredAt,
        auditId,
        survivorId,
        loserId,
        survivorId,
        survivorId,
        survivorId,
        loserId,
        loserId,
        loserId,
        survivorId,
        loserId,
        survivorId,
        survivorId,
        survivorId
      )
  );

  // Dedup before re-pointing: drop loser rows whose target slot the survivor
  // already occupies (identities under idx_user_identities_provider; read
  // states routinely, where both split rows read the same session).
  addOperations(BEFORE_SKILL_PROFILE_OPERATIONS);

  // Profile resolution uses this generation as a consistency fence. Advance
  // it before any profile membership or ownership rows are changed.
  add(
    SKILL_CATALOG_GENERATION_OPERATION.key,
    SKILL_CATALOG_GENERATION_OPERATION.execute(db, survivorId, loserId)
  );

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

  // Preserve the survivor's RBAC assignment before deleting the loser.
  add(
    "roleAssignmentsRemoved",
    db.prepare("DELETE FROM user_role_assignments WHERE user_id = ?").bind(loserId)
  );
  addOperations(FINAL_REPOINT_OPERATIONS);

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

  const results: SqlResult[] = await db.batch(statements);

  const counts = emptyCounts();
  for (const [key, index] of Object.entries(track) as [UserMergeCountKey, number][]) {
    counts[key] = (results[index]?.meta.changes ?? 0) / (RESULT_CHANGE_DIVISORS[key] ?? 1);
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

  const [skillProfileItemsMerged, roleAssignments, users] = await db.batch<{ count: number }>([
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
    // mergeUsers returns before previewing when the loser is absent, so an
    // executed merge always writes exactly one audit event.
    auditEventsCreated: 1,
    canonicalEmailBackfilled,
    usersDeleted: count(users),
  };
}
