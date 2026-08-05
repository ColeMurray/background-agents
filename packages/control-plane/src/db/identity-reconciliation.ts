import type { SignInProvider } from "@open-inspect/shared/sign-in-provider";
import type { SqlDatabase } from "./sql-database";

/**
 * Sign-in providers as SQL literals. Kept as literals (not built from the
 * shared constants) so the operator merge script can import this module
 * without runtime dependencies; the type-level exhaustiveness check below
 * fails compilation if a provider is ever added to SIGN_IN_PROVIDERS without
 * updating this list — and the IIF issuer expressions in the queries below
 * with it.
 */
const SQL_SIGN_IN_PROVIDERS = ["github", "google"] as const satisfies readonly SignInProvider[];
type _AllSignInProvidersListed =
  Exclude<SignInProvider, (typeof SQL_SIGN_IN_PROVIDERS)[number]> extends never ? true : never;
const _allSignInProvidersListed: _AllSignInProvidersListed = true;
void _allSignInProvidersListed;

/** Interpolated into queries below; trusted literals from the checked list. */
const SIGN_IN_PROVIDER_SQL_LIST = SQL_SIGN_IN_PROVIDERS.map((entry) => `'${entry}'`).join(", ");

/**
 * Grace period before a canonical-less zero-account auth row is swept.
 * Better Auth defers after-hooks to the end of the sign-in flow, so during
 * registration a legitimate auth row briefly exists with no canonical user
 * and no account; sweeping it mid-flight would fail that sign-in.
 */
const STRAND_SWEEP_MIN_AGE_MS = 300_000;
/** SQLite strftime('%s') compares in seconds; converted once at the bind site. */
const STRAND_SWEEP_MIN_AGE_SECONDS = Math.floor(STRAND_SWEEP_MIN_AGE_MS / 1000);

/**
 * Consistency reporting and scheduled reconciliation between the canonical
 * identity registry (users/user_identities) and the Better Auth registry
 * (auth_users/auth_accounts).
 *
 * The report parts are anti-join based on purpose: a single conflict
 * query only sees rows present on both sides, and the failure modes this
 * design guards against are *missing* rows. The reports double as migration
 * 0057's postcondition suite.
 *
 * Auto-repairs are restricted to the provably safe classes; in particular,
 * reconciliation never mints `emailVerified = 1` — verification comes only
 * from completed OAuth proof at sign-in (or 0057's one-time reviewed
 * backfill) — and never touches account-bearing rows or shared-subject
 * conflicts, which alarm for operator action via the merge script.
 */

/** R1: sign-in accounts with no user_identities projection. */
export interface AccountMissingIdentity {
  providerId: string;
  accountId: string;
  userId: string;
  /** False marks a canonical-less orphan — excluded from auto-repair (FK). */
  hasCanonicalUser: boolean;
}

/** R2: auth_users rows inconsistent with their canonical user. */
export interface AuthUserDrift {
  userId: string;
  canonicalEmail: string | null;
  authEmail: string;
  emailVerified: number;
  accountCount: number;
}

/** R3: auth_users rows with no canonical users row (strand signature). */
export interface CanonicalLessAuthUser {
  userId: string;
  accountCount: number;
}

/** R4: provider subjects owned by different users across the registries. */
export interface SharedSubjectConflict {
  botUserId: string;
  webUserId: string;
  providerId: string;
  accountId: string;
}

/**
 * R5: canonical users whose normalized email is reserved by a *different*
 * auth user while they have no same-id auth row of their own. Invisible to
 * R2 (whose same-id join needs an auth row to exist): 0057's seed and the
 * sign-in email tier both skip this state, so without this report a
 * suppressed seed would leave a clean-looking postcondition suite. The
 * affected user still signs in — implicit linking lands them on the
 * reserving row — producing a split for the merge script rather than a
 * lockout.
 */
export interface CanonicalEmailReservation {
  userId: string;
  reservingAuthUserId: string;
  reservingAccountCount: number;
}

export interface IdentityConsistencyReport {
  accountsMissingIdentity: AccountMissingIdentity[];
  authUserDrift: AuthUserDrift[];
  canonicalLessAuthUsers: CanonicalLessAuthUser[];
  sharedSubjectConflicts: SharedSubjectConflict[];
  emailReservations: CanonicalEmailReservation[];
}

export interface IdentityRepairStats {
  identitiesProjected: number;
  emailsAligned: number;
  strandsSwept: number;
  /**
   * Steps that threw this cycle. Isolated per step so one poisoned row class
   * cannot starve the remaining repairs or the residual report.
   */
  repairFailures: { step: "sweep" | "align" | "project"; message: string }[];
}

/**
 * Aggregate residual counts for the scheduled cycle. COUNT(*)-only so the
 * half-hourly job never materializes backlog rows into Worker memory —
 * row-level enumeration stays with `report()` for operator use.
 */
export interface IdentityResidualCounts {
  /** R1 rows with no canonical user — FK-blocked, never auto-repairable. */
  orphanAccounts: number;
  /**
   * R1 rows WITH a canonical user — projection should have healed them, so a
   * nonzero residual means the repair failed or raced and must alarm.
   */
  missingProjections: number;
  accountBearingDrift: number;
  zeroAccountDrift: number;
  accountBearingStrands: number;
  sharedSubjectConflicts: number;
  emailReservations: number;
}

export interface IdentityReconciliationStats extends IdentityRepairStats {
  residualOrphanAccounts: number;
  residualMissingProjections: number;
  residualAccountBearingDrift: number;
  residualZeroAccountDrift: number;
  residualAccountBearingStrands: number;
  residualSharedSubjectConflicts: number;
  residualEmailReservations: number;
}

interface AccountMissingIdentityRow {
  providerId: string;
  accountId: string;
  userId: string;
  hasCanonicalUser: number;
}

export class IdentityReconciliationStore {
  constructor(private readonly db: SqlDatabase) {}

  async report(): Promise<IdentityConsistencyReport> {
    const [r1, r2, r3, r4, r5] = await this.db.batch([
      this.db.prepare(
        `SELECT
           auth_accounts.providerId AS providerId,
           auth_accounts.accountId AS accountId,
           auth_accounts.userId AS userId,
           EXISTS (SELECT 1 FROM users WHERE users.id = auth_accounts.userId)
             AS hasCanonicalUser
         FROM auth_accounts
         WHERE auth_accounts.providerId IN (${SIGN_IN_PROVIDER_SQL_LIST})
           AND NOT EXISTS (
             SELECT 1
             FROM user_identities
             WHERE user_identities.provider = auth_accounts.providerId
               AND user_identities.provider_user_id = auth_accounts.accountId
           )
         ORDER BY auth_accounts.providerId, auth_accounts.accountId`
      ),
      this.db.prepare(
        `SELECT
           auth_users.id AS userId,
           lower(trim(users.email)) AS canonicalEmail,
           auth_users.email AS authEmail,
           auth_users.emailVerified AS emailVerified,
           (SELECT COUNT(*) FROM auth_accounts WHERE auth_accounts.userId = auth_users.id)
             AS accountCount
         FROM auth_users
         JOIN users ON users.id = auth_users.id
         WHERE users.email IS NULL
           OR lower(trim(users.email)) <> auth_users.email
           OR auth_users.emailVerified = 0
         ORDER BY auth_users.id`
      ),
      this.db.prepare(
        `SELECT
           auth_users.id AS userId,
           (SELECT COUNT(*) FROM auth_accounts WHERE auth_accounts.userId = auth_users.id)
             AS accountCount
         FROM auth_users
         WHERE NOT EXISTS (SELECT 1 FROM users WHERE users.id = auth_users.id)
         ORDER BY auth_users.id`
      ),
      this.db.prepare(
        `SELECT
           user_identities.user_id AS botUserId,
           auth_accounts.userId AS webUserId,
           auth_accounts.providerId AS providerId,
           auth_accounts.accountId AS accountId
         FROM auth_accounts
         JOIN user_identities
           ON user_identities.provider = auth_accounts.providerId
          AND user_identities.provider_user_id = auth_accounts.accountId
         WHERE auth_accounts.userId <> user_identities.user_id
         ORDER BY auth_accounts.providerId, auth_accounts.accountId`
      ),
      this.db.prepare(
        `SELECT
           users.id AS userId,
           auth_users.id AS reservingAuthUserId,
           (SELECT COUNT(*) FROM auth_accounts WHERE auth_accounts.userId = auth_users.id)
             AS reservingAccountCount
         FROM users
         JOIN auth_users
           ON auth_users.email = lower(trim(users.email))
          AND auth_users.id <> users.id
         WHERE users.email IS NOT NULL
           AND length(trim(users.email)) > 0
           AND NOT EXISTS (SELECT 1 FROM auth_users AS own WHERE own.id = users.id)
         ORDER BY users.id`
      ),
    ]);

    return {
      accountsMissingIdentity: (r1.results as AccountMissingIdentityRow[]).map((row) => ({
        providerId: row.providerId,
        accountId: row.accountId,
        userId: row.userId,
        hasCanonicalUser: row.hasCanonicalUser === 1,
      })),
      authUserDrift: r2.results as AuthUserDrift[],
      canonicalLessAuthUsers: r3.results as CanonicalLessAuthUser[],
      sharedSubjectConflicts: r4.results as SharedSubjectConflict[],
      emailReservations: r5.results as CanonicalEmailReservation[],
    };
  }

  /**
   * The report's classes as COUNT(*) aggregates, for the scheduled cycle.
   * Predicates mirror `report()` exactly; only the projection differs.
   */
  async residuals(): Promise<IdentityResidualCounts> {
    const missingIdentityPredicate = `
      auth_accounts.providerId IN (${SIGN_IN_PROVIDER_SQL_LIST})
      AND NOT EXISTS (
        SELECT 1
        FROM user_identities
        WHERE user_identities.provider = auth_accounts.providerId
          AND user_identities.provider_user_id = auth_accounts.accountId
      )`;
    const driftPredicate = `
      (
        users.email IS NULL
        OR lower(trim(users.email)) <> auth_users.email
        OR auth_users.emailVerified = 0
      )`;
    const accountCount = `(
      SELECT COUNT(*) FROM auth_accounts WHERE auth_accounts.userId = auth_users.id
    )`;
    const [
      orphanAccounts,
      missingProjections,
      accountBearingDrift,
      zeroAccountDrift,
      accountBearingStrands,
      sharedSubjectConflicts,
      emailReservations,
    ] = await this.db.batch<{ count: number }>([
      this.db.prepare(
        `SELECT COUNT(*) AS count FROM auth_accounts
         WHERE ${missingIdentityPredicate}
           AND NOT EXISTS (SELECT 1 FROM users WHERE users.id = auth_accounts.userId)`
      ),
      this.db.prepare(
        `SELECT COUNT(*) AS count FROM auth_accounts
         WHERE ${missingIdentityPredicate}
           AND EXISTS (SELECT 1 FROM users WHERE users.id = auth_accounts.userId)`
      ),
      this.db.prepare(
        `SELECT COUNT(*) AS count FROM auth_users
         JOIN users ON users.id = auth_users.id
         WHERE ${driftPredicate} AND ${accountCount} > 0`
      ),
      this.db.prepare(
        `SELECT COUNT(*) AS count FROM auth_users
         JOIN users ON users.id = auth_users.id
         WHERE ${driftPredicate} AND ${accountCount} = 0`
      ),
      this.db.prepare(
        `SELECT COUNT(*) AS count FROM auth_users
         WHERE NOT EXISTS (SELECT 1 FROM users WHERE users.id = auth_users.id)
           AND ${accountCount} > 0`
      ),
      this.db.prepare(
        `SELECT COUNT(*) AS count FROM auth_accounts
         JOIN user_identities
           ON user_identities.provider = auth_accounts.providerId
          AND user_identities.provider_user_id = auth_accounts.accountId
         WHERE auth_accounts.userId <> user_identities.user_id`
      ),
      this.db.prepare(
        `SELECT COUNT(*) AS count FROM users
         JOIN auth_users
           ON auth_users.email = lower(trim(users.email))
          AND auth_users.id <> users.id
         WHERE users.email IS NOT NULL
           AND length(trim(users.email)) > 0
           AND NOT EXISTS (SELECT 1 FROM auth_users AS own WHERE own.id = users.id)`
      ),
    ]);
    const count = (result: { results: { count: number }[] }) => result.results[0]?.count ?? 0;
    return {
      orphanAccounts: count(orphanAccounts),
      missingProjections: count(missingProjections),
      accountBearingDrift: count(accountBearingDrift),
      zeroAccountDrift: count(zeroAccountDrift),
      accountBearingStrands: count(accountBearingStrands),
      sharedSubjectConflicts: count(sharedSubjectConflicts),
      emailReservations: count(emailReservations),
    };
  }

  /**
   * Applies the safe auto-repairs in dependency order: sweeping zero-account
   * strands first frees any emails they reserve, email alignment then cannot
   * collide with them, and identity projection is independent of both.
   */
  async applySafeRepairs(): Promise<IdentityRepairStats> {
    const stats: IdentityRepairStats = {
      strandsSwept: 0,
      emailsAligned: 0,
      identitiesProjected: 0,
      repairFailures: [],
    };
    const step = async (
      name: IdentityRepairStats["repairFailures"][number]["step"],
      run: () => Promise<number>
    ): Promise<number> => {
      try {
        return await run();
      } catch (error) {
        stats.repairFailures.push({
          step: name,
          message: error instanceof Error ? error.message : String(error),
        });
        return 0;
      }
    };

    stats.strandsSwept = await step("sweep", async () => {
      const result = await this.db
        .prepare(
          `DELETE FROM auth_users
           WHERE NOT EXISTS (SELECT 1 FROM users WHERE users.id = auth_users.id)
             AND NOT EXISTS (
               SELECT 1 FROM auth_accounts WHERE auth_accounts.userId = auth_users.id
             )
             AND CAST(strftime('%s', auth_users.createdAt) AS INTEGER)
               < CAST(strftime('%s', 'now') AS INTEGER) - ?`
        )
        .bind(STRAND_SWEEP_MIN_AGE_SECONDS)
        .run();
      return result.meta.changes;
    });

    // OR IGNORE: the other-owner guard sees only pre-statement state, so two
    // whitespace-variant canonical emails normalizing to one value could
    // still collide intra-statement; the loser of that race stays in R2.
    stats.emailsAligned = await step("align", async () => {
      const result = await this.db
        .prepare(
          `UPDATE OR IGNORE auth_users
           SET
             email = (
               SELECT lower(trim(users.email)) FROM users WHERE users.id = auth_users.id
             ),
             updatedAt = ?
           WHERE EXISTS (
               SELECT 1
               FROM users
               WHERE users.id = auth_users.id
                 AND users.email IS NOT NULL
                 AND length(trim(users.email)) > 0
                 AND lower(trim(users.email)) <> auth_users.email
             )
             AND NOT EXISTS (
               SELECT 1 FROM auth_accounts WHERE auth_accounts.userId = auth_users.id
             )
             AND NOT EXISTS (
               SELECT 1
               FROM auth_users AS other
               WHERE other.id <> auth_users.id
                 AND other.email = (
                   SELECT lower(trim(users.email)) FROM users WHERE users.id = auth_users.id
                 )
             )`
        )
        .bind(new Date().toISOString())
        .run();
      return result.meta.changes;
    });

    stats.identitiesProjected = await step("project", async () => {
      const result = await this.db
        .prepare(
          `INSERT INTO user_identities (
             id, user_id, provider, provider_user_id, provider_login,
             provider_email, provider_issuer, created_at
           )
           SELECT
             lower(hex(randomblob(16))),
             auth_accounts.userId,
             auth_accounts.providerId,
             auth_accounts.accountId,
             NULL,
             NULL,
             IIF(
               auth_accounts.providerId = 'github',
               'https://github.com',
               'https://accounts.google.com'
             ),
             -- strftime returns NULL for an unparseable createdAt, which
             -- would violate created_at NOT NULL and permanently fail this
             -- repair step. Fall back to now.
             coalesce(
               CAST(strftime('%s', auth_accounts.createdAt) AS INTEGER) * 1000,
               CAST(strftime('%s', 'now') AS INTEGER) * 1000
             )
           FROM auth_accounts
           JOIN users ON users.id = auth_accounts.userId
           WHERE auth_accounts.providerId IN (${SIGN_IN_PROVIDER_SQL_LIST})
             AND NOT EXISTS (
               SELECT 1
               FROM user_identities
               WHERE user_identities.provider = auth_accounts.providerId
                 AND user_identities.provider_user_id = auth_accounts.accountId
             )
           ON CONFLICT DO NOTHING`
        )
        .run();
      return result.meta.changes;
    });

    return stats;
  }
}
