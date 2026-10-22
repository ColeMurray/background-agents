import type { SqlDatabase, SqlResult, SqlStatement } from "./sql-database";

/**
 * Split-merge primitive: converge a loser canonical user's entire graph onto
 * a survivor. Splits arise when two canonical rows turn out to be the same
 * person (e.g. a Slack-attributed email beside a GitHub-subject row —
 * `auth.subject_email_collision` enumerates the live cases).
 *
 * Callers: the operator CLI (`scripts/merge-split-users.ts`) and the
 * administrator merge flow (`authorization/member-merge.ts`). An
 * administrator merge passes a `user` actor whose authorization guard is
 * re-evaluated inside the atomic batch.
 *
 * The execute batch opens with an audit insert that records a typed decision
 * (`applied`, or why the write-time preconditions failed), and every later
 * write is gated on that row being `applied`. A refused merge therefore
 * changes nothing but its own audited refusal, and the caller learns exactly
 * which precondition failed at write time.
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
 *   survivor has no email of its own, and only if both still match the
 *   preflight snapshot at write time.
 * - A merge never leaves a user with two GitHub identities: session
 *   attribution and the GitHub credential authority both reject that state.
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

/** Reasons the in-batch decision can refuse a merge at write time. */
type UserMergeWriteRefusal =
  "actor_authorization_changed" | "preconditions_changed" | "source_changed" | "identity_conflict";

const WRITE_REFUSAL_MESSAGES: Record<UserMergeWriteRefusal, string> = {
  actor_authorization_changed: "The acting user's authorization changed; nothing was merged",
  preconditions_changed: "User roles or suspension changed; nothing was merged",
  source_changed: "The merged-in user's email changed; nothing was merged",
  identity_conflict: "Both users have a GitHub identity; nothing was merged",
};

/** Stable reasons a merge was refused, at preflight or by the in-batch decision. */
export type UserMergeErrorCode =
  | "self_merge"
  | "survivor_not_found"
  | "role_assignment_missing"
  | "role_conflict"
  | "suspension_conflict"
  | "owner_suspended"
  | UserMergeWriteRefusal;

export class UserMergeError extends Error {
  // A declared field, not a parameter property: the operator CLI loads this
  // module under Node's type-stripping loader, which rejects the latter.
  readonly code: UserMergeErrorCode;

  constructor(code: UserMergeErrorCode, message: string) {
    super(message);
    this.name = "UserMergeError";
    this.code = code;
  }
}

/** A parameterized SQL predicate evaluated inside the merge batch. */
export interface UserMergeGuard {
  readonly sql: string;
  readonly values: readonly unknown[];
}

/**
 * Who performs an executed merge. A `user` actor is recorded on the audit
 * event, and its `guard` must still hold when the batch runs.
 */
export type UserMergeActor =
  | { readonly kind: "operator" }
  | {
      readonly kind: "user";
      readonly userId: string;
      readonly requestId: string;
      readonly guard: UserMergeGuard;
    };

export interface UserMergeOptions {
  readonly survivorId: string;
  readonly loserId: string;
  readonly dryRun?: boolean;
  /** Defaults to the operator CLI. */
  readonly actor?: UserMergeActor;
}

const OPERATOR_ACTOR: UserMergeActor = { kind: "operator" };

/** Every count a merge reports. Mirrored by `USER_MERGE_COUNT_KEYS` in `@open-inspect/shared/rbac`. */
export const USER_MERGE_COUNT_KEYS = [
  "memoriesOwnedRepointed",
  "memoryAuthorsRepointed",
  "memoryRevisionAuthorsRepointed",
  "memoryDecidersRepointed",
  "memoryArchiversRepointed",
  "memoryManifestOwnersRepointed",
  "memoryPreferencesDeduped",
  "memoryPreferencesRepointed",
  "identitiesDeduped",
  "identitiesRepointed",
  "readStatesDeduped",
  "readStatesRepointed",
  "teamLeadRolesPromoted",
  "teamMembershipsDeduped",
  "teamMembershipsRepointed",
  "sessionCollaboratorsDeduped",
  "sessionCollaboratorsRepointed",
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
/** Per-record counts a merge changed, or a dry run would change. */
export type UserMergeCounts = Record<UserMergeCountKey, number>;

const RESULT_CHANGE_DIVISORS: Partial<Record<UserMergeCountKey, number>> = {
  // The assignment UPDATE trigger also advances skills_catalog_state once per
  // changed assignment, and D1 includes both rows in meta.changes.
  skillAssignmentsCreatedRepointed: 2,
};

/** Holds only when the batch's decision row recorded `applied`. */
interface WriteGate {
  readonly sql: string;
  readonly values: readonly unknown[];
}

interface MergeOperation {
  readonly key: UserMergeCountKey;
  readonly execute: (
    db: SqlDatabase,
    survivorId: string,
    loserId: string,
    gate: WriteGate
  ) => SqlStatement;
  readonly preview: (db: SqlDatabase, survivorId: string, loserId: string) => SqlStatement;
  readonly subtract?: UserMergeCountKey;
}

function regularRepoint(key: UserMergeCountKey, table: string, column = "user_id"): MergeOperation {
  return {
    key,
    execute: (db, survivorId, loserId, gate) =>
      db
        .prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ? AND ${gate.sql}`)
        .bind(survivorId, loserId, ...gate.values),
    preview: (db, _survivorId, loserId) =>
      db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`).bind(loserId),
  };
}

function regularDelete(key: UserMergeCountKey, table: string, column = "user_id"): MergeOperation {
  return {
    key,
    execute: (db, _survivorId, loserId, gate) =>
      db
        .prepare(`DELETE FROM ${table} WHERE ${column} = ? AND ${gate.sql}`)
        .bind(loserId, ...gate.values),
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
      execute: (db, survivorId, loserId, gate) =>
        db
          .prepare(
            `DELETE FROM ${options.table}
             WHERE user_id = ? AND ${options.collision} AND ${gate.sql}`
          )
          .bind(loserId, survivorId, ...gate.values),
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
  ...dedupeThenRepoint({
    dedupeKey: "teamMembershipsDeduped",
    repointKey: "teamMembershipsRepointed",
    table: "team_memberships",
    collision: `EXISTS (
      SELECT 1 FROM team_memberships AS survivor_membership
      WHERE survivor_membership.user_id = ?
        AND survivor_membership.team_id = team_memberships.team_id
    )`,
  }),
  ...dedupeThenRepoint({
    dedupeKey: "sessionCollaboratorsDeduped",
    repointKey: "sessionCollaboratorsRepointed",
    table: "session_collaborators",
    collision: `EXISTS (
      SELECT 1 FROM session_collaborators AS survivor_collaborator
      WHERE survivor_collaborator.user_id = ?
        AND survivor_collaborator.session_id = session_collaborators.session_id
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
  execute: (db, _survivorId, loserId, gate) =>
    db
      .prepare(
        `UPDATE skills_catalog_state SET generation = generation + 1
         WHERE singleton = 1
           AND EXISTS (SELECT 1 FROM skill_profiles WHERE user_id = ?)
           AND ${gate.sql}`
      )
      .bind(loserId, ...gate.values),
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
  regularRepoint("memoriesOwnedRepointed", "memories", "owner_user_id"),
  regularRepoint("memoryAuthorsRepointed", "memories", "author_user_id"),
  regularRepoint("memoryRevisionAuthorsRepointed", "memory_revisions", "author_user_id"),
  regularRepoint("memoryDecidersRepointed", "memories", "decided_by"),
  regularRepoint("memoryArchiversRepointed", "memories", "archived_by"),
  regularRepoint(
    "memoryManifestOwnersRepointed",
    "session_memory_manifests",
    "personal_owner_user_id"
  ),
  ...dedupeThenRepoint({
    dedupeKey: "memoryPreferencesDeduped",
    repointKey: "memoryPreferencesRepointed",
    table: "memory_preferences",
    collision: `EXISTS (SELECT 1 FROM memory_preferences WHERE user_id = ?)`,
  }),
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
 * Whether an applied merge already folded `loserId` into `survivorId`, per the
 * audit provenance every executed merge records. Lets callers treat a replay of
 * the exact pair as completed rather than as a missing user.
 */
export async function hasCompletedUserMerge(
  db: SqlDatabase,
  survivorId: string,
  loserId: string
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS merged FROM authorization_audit_events
       WHERE action = 'workspace.user_merged' AND operation_result = 'applied'
         AND resource_id = ? AND target_user_id_snapshot = ?
       LIMIT 1`
    )
    .bind(survivorId, loserId)
    .first<{ merged: number }>();
  return row !== null;
}

/** SQL that holds when merging would leave the survivor with two GitHub identities. */
const GITHUB_IDENTITY_CONFLICT_SQL = `EXISTS (
    SELECT 1 FROM user_identities WHERE user_id = ? AND provider = 'github'
  ) AND EXISTS (
    SELECT 1 FROM user_identities WHERE user_id = ? AND provider = 'github'
  )`;

/**
 * Merge a canonical user into a survivor after validating their RBAC assignments.
 */
export async function mergeUsers(
  db: SqlDatabase,
  options: UserMergeOptions
): Promise<UserMergeResult> {
  const { survivorId, loserId } = options;
  if (survivorId === loserId) {
    throw new UserMergeError("self_merge", "Survivor and loser must be different users");
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
    throw new UserMergeError("survivor_not_found", `Survivor user ${survivorId} not found`);
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
    return { survivorId, loserId, dryRun: options.dryRun === true, counts: emptyUserMergeCounts() };
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
    throw new UserMergeError(
      "role_assignment_missing",
      "Both users must have explicit role assignments before merging"
    );
  }
  if (survivorRole && loserRole && survivorRole.role_id !== loserRole.role_id) {
    throw new UserMergeError("role_conflict", "Resolve conflicting user roles before merging");
  }
  if ((survivor.suspended_at === null) !== (loser.suspended_at === null)) {
    throw new UserMergeError(
      "suspension_conflict",
      "Resolve conflicting user suspension states before merging"
    );
  }
  if (loserRole?.role_key === "owner" && survivor.suspended_at !== null) {
    throw new UserMergeError(
      "owner_suspended",
      "The surviving Owner must be active before merging"
    );
  }
  const identityConflict = await db
    .prepare(`SELECT (${GITHUB_IDENTITY_CONFLICT_SQL}) AS conflict`)
    .bind(survivorId, loserId)
    .first<{ conflict: number }>();
  if (identityConflict?.conflict) {
    throw new UserMergeError("identity_conflict", WRITE_REFUSAL_MESSAGES.identity_conflict);
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

  const auditId = crypto.randomUUID();
  const occurredAt = Date.now();
  const actor = options.actor ?? OPERATOR_ACTOR;
  const principal =
    actor.kind === "user"
      ? {
          requestId: actor.requestId,
          kind: "user",
          actorUserId: actor.userId,
          actorService: null,
          reasonCode: "member_merge",
          guard: actor.guard,
        }
      : {
          requestId: `operator-cli:${auditId}`,
          kind: "service",
          actorUserId: null,
          actorService: "operator-cli",
          reasonCode: "operator_merge",
          guard: { sql: "1", values: [] },
        };
  const gate: WriteGate = {
    sql: `EXISTS (
      SELECT 1 FROM authorization_audit_events
      WHERE id = ? AND operation_result = 'applied'
    )`,
    values: [auditId],
  };

  const statements: SqlStatement[] = [];
  const track: Partial<Record<UserMergeCountKey, number>> = {};
  const add = (key: UserMergeCountKey, statement: SqlStatement) => {
    track[key] = statements.length;
    statements.push(statement);
  };
  const addOperations = (operations: readonly MergeOperation[]) => {
    for (const operation of operations) {
      add(operation.key, operation.execute(db, survivorId, loserId, gate));
    }
  };

  // The decision re-checks every preflight invariant against write-time state
  // and is recorded, applied or refused, on the audit row. Each later
  // statement is gated on that row, so a refusal writes nothing else.
  const decisionIndex = statements.length;
  add(
    "auditEventsCreated",
    db
      .prepare(
        `WITH decision(status) AS (
           SELECT CASE
             WHEN NOT (${principal.guard.sql}) THEN 'actor_authorization_changed'
             WHEN NOT EXISTS (
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
             ) THEN 'preconditions_changed'
             WHEN NOT EXISTS (
               SELECT 1 FROM users WHERE id = ? AND email IS ? AND email_verified = ?
             ) THEN 'source_changed'
             WHEN ${GITHUB_IDENTITY_CONFLICT_SQL} THEN 'identity_conflict'
             ELSE 'applied'
           END
         )
         INSERT INTO authorization_audit_events
            (id, occurred_at, request_id, principal_kind, actor_user_id_snapshot,
             actor_service_snapshot, action, resource_type, resource_id,
             target_user_id_snapshot, reason_code, operation_result, metadata_json)
         SELECT ?, ?, ?, ?, ?, ?, 'workspace.user_merged', 'user', ?, ?,
           CASE status WHEN 'applied' THEN ? ELSE status END,
           CASE status
             WHEN 'applied' THEN 'applied'
             WHEN 'actor_authorization_changed' THEN 'denied'
             ELSE 'rejected'
           END,
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
             'after', json(CASE status
               WHEN 'applied' THEN json_object(
                 'survivor', json_object(
                   'userId', ?,
                   'roleId', (SELECT role_id FROM user_role_assignments WHERE user_id = ?),
                   'suspendedAt', (SELECT suspended_at FROM users WHERE id = ?)
                 ),
                 'loser', NULL
               )
               ELSE json_object(
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
               )
             END)
           )
         FROM decision
         RETURNING operation_result, reason_code`
      )
      .bind(
        ...principal.guard.values,
        loserId,
        survivorId,
        loserId,
        loser.email,
        loser.email_verified,
        survivorId,
        loserId,
        auditId,
        occurredAt,
        principal.requestId,
        principal.kind,
        principal.actorUserId,
        principal.actorService,
        survivorId,
        loserId,
        principal.reasonCode,
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
        survivorId,
        survivorId,
        survivorId,
        survivorId,
        loserId,
        loserId,
        loserId
      )
  );

  // Dedup before re-pointing: drop loser rows whose target slot the survivor
  // already occupies (identities under idx_user_identities_provider; read
  // states routinely, where both split rows read the same session). Keep the
  // stronger lead role before deleting a colliding loser membership.
  add(
    "teamLeadRolesPromoted",
    db
      .prepare(
        `UPDATE team_memberships SET role = 'lead'
         WHERE user_id = ? AND role = 'member'
           AND EXISTS (
             SELECT 1 FROM team_memberships AS loser_membership
             WHERE loser_membership.team_id = team_memberships.team_id
               AND loser_membership.user_id = ? AND loser_membership.role = 'lead'
           )
           AND ${gate.sql}`
      )
      .bind(survivorId, loserId, ...gate.values)
  );
  addOperations(BEFORE_SKILL_PROFILE_OPERATIONS);

  // Profile resolution uses this generation as a consistency fence. Advance
  // it before any profile membership or ownership rows are changed.
  add(
    SKILL_CATALOG_GENERATION_OPERATION.key,
    SKILL_CATALOG_GENERATION_OPERATION.execute(db, survivorId, loserId, gate)
  );

  // Merge items before deleting colliding skill profiles.
  add(
    "skillProfileItemsMerged",
    db
      .prepare(
        `INSERT INTO skill_profile_items (profile_id, skill_id)
         SELECT survivor_profile.id, loser_item.skill_id
         FROM skill_profiles loser_profile
         JOIN skill_profiles survivor_profile
           ON survivor_profile.user_id = ? AND survivor_profile.name = loser_profile.name
         JOIN skill_profile_items loser_item ON loser_item.profile_id = loser_profile.id
         WHERE loser_profile.user_id = ? AND ${gate.sql}
         ON CONFLICT DO NOTHING`
      )
      .bind(survivorId, loserId, ...gate.values)
  );
  addOperations(SKILL_PROFILE_OPERATIONS);

  // Preserve the survivor's RBAC assignment before deleting the loser.
  add(
    "roleAssignmentsRemoved",
    db
      .prepare(`DELETE FROM user_role_assignments WHERE user_id = ? AND ${gate.sql}`)
      .bind(loserId, ...gate.values)
  );
  addOperations(FINAL_REPOINT_OPERATIONS);

  add(
    "usersDeleted",
    db.prepare(`DELETE FROM users WHERE id = ? AND ${gate.sql}`).bind(loserId, ...gate.values)
  );
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
             )
             AND ${gate.sql}`
        )
        .bind(
          backfillEmail,
          backfillVerified,
          Date.now(),
          survivorId,
          backfillEmail,
          ...gate.values
        )
    );
  }

  const results: SqlResult[] = await db.batch(statements);
  const decision = results[decisionIndex]?.results[0] as
    { operation_result: string; reason_code: string } | undefined;
  if (!decision) throw new Error("User merge decision was not recorded");
  if (decision.operation_result !== "applied") {
    const refusal = decision.reason_code as UserMergeWriteRefusal;
    throw new UserMergeError(refusal, WRITE_REFUSAL_MESSAGES[refusal]);
  }

  const counts = emptyUserMergeCounts();
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

/** All-zero counts, as reported by a merge that had nothing left to do. */
export function emptyUserMergeCounts(): UserMergeCounts {
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
  const operationCounts = emptyUserMergeCounts();
  for (const [index, operation] of TABLE_OPERATIONS.entries()) {
    const total = operationResults[index]?.results[0]?.count ?? 0;
    operationCounts[operation.key] =
      total - (operation.subtract ? operationCounts[operation.subtract] : 0);
  }

  const [teamLeadRolesPromoted, skillProfileItemsMerged, roleAssignments, users] = await db.batch<{
    count: number;
  }>([
    db
      .prepare(
        `SELECT COUNT(*) AS count FROM team_memberships survivor_membership
         JOIN team_memberships loser_membership
           ON loser_membership.team_id = survivor_membership.team_id
         WHERE survivor_membership.user_id = ? AND survivor_membership.role = 'member'
           AND loser_membership.user_id = ? AND loser_membership.role = 'lead'`
      )
      .bind(survivorId, loserId),
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
    teamLeadRolesPromoted: count(teamLeadRolesPromoted),
    skillProfileItemsMerged: count(skillProfileItemsMerged),
    roleAssignmentsRemoved: count(roleAssignments),
    // mergeUsers returns before previewing when the loser is absent, so an
    // executed merge always writes exactly one audit event.
    auditEventsCreated: 1,
    canonicalEmailBackfilled,
    usersDeleted: count(users),
  };
}
