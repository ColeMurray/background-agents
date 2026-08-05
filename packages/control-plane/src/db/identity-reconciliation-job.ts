import { createLogger } from "../logger";
import {
  IdentityReconciliationStore,
  type IdentityReconciliationStats,
} from "./identity-reconciliation";
import type { SqlDatabase } from "./sql-database";

const logger = createLogger("auth:identity-reconciliation");

/**
 * One scheduled reconciliation cycle: apply the safe repairs, then report the
 * residual state. Everything left after repair is either self-healing at the
 * affected user's next sign-in (zero-account drift) or operator merge work
 * (account-bearing rows, shared subjects) — the latter classes are alarmed.
 */
export async function runIdentityReconciliation(
  db: SqlDatabase
): Promise<IdentityReconciliationStats> {
  const store = new IdentityReconciliationStore(db);
  const repairs = await store.applySafeRepairs();
  const report = await store.report();

  const stats: IdentityReconciliationStats = {
    ...repairs,
    residualOrphanAccounts: report.accountsMissingIdentity.filter((row) => !row.hasCanonicalUser)
      .length,
    residualAccountBearingDrift: report.authUserDrift.filter((row) => row.accountCount > 0).length,
    residualZeroAccountDrift: report.authUserDrift.filter((row) => row.accountCount === 0).length,
    residualAccountBearingStrands: report.canonicalLessAuthUsers.filter(
      (row) => row.accountCount > 0
    ).length,
    residualSharedSubjectConflicts: report.sharedSubjectConflicts.length,
  };

  logger.info("Identity reconciliation cycle complete", {
    event: "auth.reconciliation_complete",
    ...stats,
  });
  if (stats.residualAccountBearingStrands > 0 || stats.residualSharedSubjectConflicts > 0) {
    logger.warn("Identity registries hold conflicts needing operator merges", {
      event: "auth.reconciliation_conflicts",
      account_bearing_strands: stats.residualAccountBearingStrands,
      shared_subject_conflicts: stats.residualSharedSubjectConflicts,
    });
  }
  if (stats.residualAccountBearingDrift > 0) {
    // Distinct event: same-id email divergence can be a legitimate standing
    // state (e.g. a Slack-attributed canonical email beside a personal
    // verified sign-in email) with nothing to merge — keep it separately
    // routable so it doesn't drown the actionable conflict alarm.
    logger.warn("Auth users hold account-bearing email drift for operator review", {
      event: "auth.reconciliation_account_drift",
      account_bearing_drift: stats.residualAccountBearingDrift,
    });
  }
  return stats;
}
