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
  // Aggregate counts only: the scheduled cycle must stay bounded regardless
  // of backlog size — row-level enumeration is the operator report's job.
  const residuals = await store.residuals();

  const stats: IdentityReconciliationStats = {
    ...repairs,
    residualOrphanAccounts: residuals.orphanAccounts,
    residualMissingProjections: residuals.missingProjections,
    residualAccountBearingDrift: residuals.accountBearingDrift,
    residualZeroAccountDrift: residuals.zeroAccountDrift,
    residualAccountBearingStrands: residuals.accountBearingStrands,
    residualSharedSubjectConflicts: residuals.sharedSubjectConflicts,
    residualEmailReservations: residuals.emailReservations,
  };

  for (const failure of repairs.repairFailures) {
    logger.error("Identity reconciliation repair step failed", {
      event: "auth.reconciliation_repair_failed",
      step: failure.step,
      error: failure.message,
    });
  }
  logger.info("Identity reconciliation cycle complete", {
    event: "auth.reconciliation_complete",
    ...stats,
    repairFailures: stats.repairFailures.length,
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
  if (stats.residualMissingProjections > 0) {
    // Canonical-backed accounts with no identity projection should have been
    // auto-repaired this cycle — a residual means the repair step failed or
    // raced, and bot ingress will mint phantom splits until it heals.
    logger.warn("Identity projections remain missing after repair", {
      event: "auth.reconciliation_missed_projections",
      missing_projections: stats.residualMissingProjections,
    });
  }
  if (stats.residualEmailReservations > 0) {
    // Canonical users whose email a different auth user reserves: invisible
    // to R2's same-id join, sign-in lands them on the reserving row (a split
    // for the merge script), so the standing state needs its own alarm.
    logger.warn("Canonical user emails are reserved by different auth users", {
      event: "auth.reconciliation_email_reservations",
      email_reservations: stats.residualEmailReservations,
    });
  }
  return stats;
}
