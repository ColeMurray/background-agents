import { DEFAULT_HARNESS, type HarnessId } from "@open-inspect/shared/harnesses";
import type { Team } from "@open-inspect/shared/types/teams";
import type { AutomationRow } from "../db/automation-store";
import {
  AutomationModelProviderAuthStore,
  toProviderSelections,
} from "../db/automation-model-provider-auth";
import type { SqlDatabase } from "../db/sql-database";
import type { SessionModelProviderAuthInput } from "../model-provider-accounts/provider-auth-contracts";
import { resolveSessionProviderAuth } from "../session/provider-account-resolution";
import type { ExecutionPrincipal } from "./launch-contracts";

export async function resolveAutomationProviderAuth(
  db: SqlDatabase,
  automationId: string,
  harness: HarnessId = DEFAULT_HARNESS
): Promise<SessionModelProviderAuthInput[]> {
  const pinRows = await new AutomationModelProviderAuthStore(db).list(automationId);
  const explicit = toProviderSelections(pinRows);
  const resolved = await resolveSessionProviderAuth(db, { explicit, unattended: true, harness });
  const pinnedProviders = new Set(pinRows.map((pin) => pin.provider));
  return resolved.map((auth) =>
    pinnedProviders.has(auth.provider) && auth.selectionSource === "explicit"
      ? { ...auth, selectionSource: "automation_pin" }
      : auth
  );
}

/** Reason code for an execution authorization denial, given the owning team's current state. */
export function executionDenialReason(team: Team | null): string {
  return team?.archivedAt != null ? "team_archived" : "execution_authorization_denied";
}

/** The automation owner as an unattended firing's execution principal; null without an owner. */
export function ownerExecutionPrincipal(automation: AutomationRow): ExecutionPrincipal | null {
  return automation.user_id
    ? {
        platformUserId: automation.user_id,
        participantUserId: automation.created_by,
        scmEnrichment: null,
      }
    : null;
}
