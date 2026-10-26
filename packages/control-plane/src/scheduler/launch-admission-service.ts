import { getValidHarnessOrDefault, type HarnessId } from "@open-inspect/shared/harnesses";
import type { Team } from "@open-inspect/shared/types/teams";
import type { AutomationRow, AutomationRunRow, TeamGrantsVersion } from "../db/automation-store";
import type { TeamRepositoryGrantStore } from "../db/team-repository-grants";
import type { AutomationSessionTarget } from "../automation/session-target";
import type { SessionModelProviderAuthInput } from "../model-provider-accounts/provider-auth-contracts";
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

export interface AutomationLaunchAdmissionServiceDeps {
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

/** Snapshot launch targets and provider policy before guarded invocation admission. */
export class AutomationLaunchAdmissionService implements LaunchAdmissionOperations {
  constructor(private readonly deps: AutomationLaunchAdmissionServiceDeps) {}

  /** Capture targets and the grants version checked by the caller's guarded admission write. */
  async resolveTeamTargets(
    automation: AutomationRow,
    team: Team,
    candidates: readonly AutomationRunRow[]
  ): ReturnType<LaunchAdmissionOperations["resolveTeamTargets"]> {
    const teamGrantsVersion = { teamId: team.id, version: team.grantsVersion };
    const targets = new Map<string, LaunchTargetSnapshot>();
    await Promise.all(
      candidates.map(async (child) => {
        try {
          targets.set(child.id, { target: await this.deps.resolveTarget(automation, child) });
        } catch (error) {
          targets.set(child.id, { error });
        }
      })
    );
    const covered = await this.deps.grants.covers(team.id, launchTargetRepoIds(targets));
    return covered ? { targets, teamGrantsVersion } : null;
  }

  /** Freeze provider routing before admission; configuration errors become child launch failures. */
  async resolveProviderAuth(automation: AutomationRow): Promise<ProviderAuthSnapshot> {
    try {
      const harness = getValidHarnessOrDefault(automation.harness);
      const providerAuth = await this.deps.resolveProviderAuth(automation.id, harness);
      await this.deps.validateHarness(
        { harness, model: automation.model, reasoningEffort: automation.reasoning_effort },
        Object.fromEntries(providerAuth.map((auth) => [auth.provider, auth.authMode]))
      );
      return { providerAuth };
    } catch (error) {
      return { error };
    }
  }
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
