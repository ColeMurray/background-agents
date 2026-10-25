import {
  DEFAULT_HARNESS,
  getValidHarnessOrDefault,
  type HarnessId,
} from "@open-inspect/shared/harnesses";
import type { Team } from "@open-inspect/shared/types/teams";
import type { AutomationRow, AutomationRunRow, TeamGrantsVersion } from "../db/automation-store";
import {
  AutomationModelProviderAuthStore,
  toProviderSelections,
} from "../db/automation-model-provider-auth";
import type { TeamRepositoryGrantStore } from "../db/team-repository-grants";
import type { SqlDatabase } from "../db/sql-database";
import type { AutomationSessionTarget } from "../automation/session-target";
import type { SessionModelProviderAuthInput } from "../model-provider-accounts/provider-auth-contracts";
import { resolveSessionProviderAuth } from "../session/provider-account-resolution";
import type { validateHarnessExecution } from "../harness-admission";
import type { LaunchTargetSnapshot, ProviderAuthSnapshot } from "./launch-contracts";

export interface LaunchAdmissionOperations {
  resolveTeamTargets(
    automation: AutomationRow,
    team: Team,
    candidates: readonly AutomationRunRow[]
  ): Promise<{
    targets: ReadonlyMap<string, LaunchTargetSnapshot>;
    teamGrantsVersion: TeamGrantsVersion;
  } | null>;
  resolveProviderAuth(automation: AutomationRow): Promise<ProviderAuthSnapshot>;
}

export interface LaunchAdmissionDeps {
  resolveTarget(automation: AutomationRow, run: AutomationRunRow): Promise<AutomationSessionTarget>;
  grants: Pick<TeamRepositoryGrantStore, "covers">;
  resolveProviderAuth(
    automationId: string,
    harness: HarnessId
  ): Promise<SessionModelProviderAuthInput[]>;
  validateHarness(
    input: Parameters<typeof validateHarnessExecution>[1],
    providerAuthModes: Parameters<typeof validateHarnessExecution>[2]
  ): Promise<void>;
}

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

/** Repository IDs that the resolved launch targets will open. */
function launchTargetRepoIds(snapshots: ReadonlyMap<string, LaunchTargetSnapshot>): number[] {
  return [...snapshots.values()].flatMap((snapshot) => {
    if (!("target" in snapshot)) return [];
    const { target } = snapshot;
    if (target.repositories) return target.repositories.map((repository) => repository.repoId);
    return target.repoId === null ? [] : [target.repoId];
  });
}

/** Capture targets and the grants version checked by the caller's guarded admission write. */
export async function resolveTeamTargets(
  deps: Pick<LaunchAdmissionDeps, "resolveTarget" | "grants">,
  automation: AutomationRow,
  team: Team,
  candidates: readonly AutomationRunRow[]
): ReturnType<LaunchAdmissionOperations["resolveTeamTargets"]> {
  const teamGrantsVersion = { teamId: team.id, version: team.grantsVersion };
  const targets = new Map<string, LaunchTargetSnapshot>();
  await Promise.all(
    candidates.map(async (child) => {
      try {
        targets.set(child.id, { target: await deps.resolveTarget(automation, child) });
      } catch (error) {
        targets.set(child.id, { error });
      }
    })
  );
  const covered = await deps.grants.covers(team.id, launchTargetRepoIds(targets));
  return covered ? { targets, teamGrantsVersion } : null;
}

/** Freeze provider routing before admission; configuration errors become child launch failures. */
export async function resolveProviderAuthSnapshot(
  deps: Pick<LaunchAdmissionDeps, "resolveProviderAuth" | "validateHarness">,
  automation: AutomationRow
): Promise<ProviderAuthSnapshot> {
  try {
    const harness = getValidHarnessOrDefault(automation.harness);
    const providerAuth = await deps.resolveProviderAuth(automation.id, harness);
    await deps.validateHarness(
      { harness, model: automation.model, reasoningEffort: automation.reasoning_effort },
      Object.fromEntries(providerAuth.map((auth) => [auth.provider, auth.authMode]))
    );
    return { providerAuth };
  } catch (error) {
    return { error };
  }
}
