import { getValidHarnessOrDefault } from "@open-inspect/shared/harnesses";
import type { SandboxSettings } from "@open-inspect/shared/types/integrations";
import type { AutomationRow, AutomationRunRow, AutomationStore } from "../db/automation-store";
import type { TeamStore } from "../db/teams";
import type { AutomationSessionTarget } from "../automation/session-target";
import type { AutomationExecutionAuthorizationRequest } from "../automation/authorization-guard";
import type { RequestContext } from "../routes/shared";
import type { SessionInitInput } from "../session/initialize";
import type { resolveSessionScopedSettings } from "../session/integration-settings-resolution";
import type { resolveManagedSkills } from "../session/skill-resolution";
import type { SessionMemorySelector } from "../memory/session-memory-selector";
import { resolvedPin } from "../session/pinned";
import { AutomationExecutionUnauthorizedError } from "./contracts";
import { executionDenialReason } from "./launch-admission";
import type { CreateAutomationSessionInput } from "./launch-contracts";

export interface AutomationSessionServiceDeps {
  store: Pick<AutomationStore, "setRunExecutionDeadline">;
  createRequestContext(automation: AutomationRow, run: AutomationRunRow): RequestContext;
  resolveTarget(run: AutomationRunRow, ctx: RequestContext): Promise<AutomationSessionTarget>;
  resolveSettings(
    members: Parameters<typeof resolveSessionScopedSettings>[1],
    environmentId: string | null
  ): ReturnType<typeof resolveSessionScopedSettings>;
  resolveSkills(
    target: Parameters<typeof resolveManagedSkills>[1],
    selection: Parameters<typeof resolveManagedSkills>[2],
    userId: string
  ): ReturnType<typeof resolveManagedSkills>;
  teams: Pick<TeamStore, "getById">;
  isAuthorized(request: AutomationExecutionAuthorizationRequest): Promise<boolean>;
  selectMemory(
    ctx: RequestContext,
    request: Parameters<SessionMemorySelector["select"]>[0]
  ): ReturnType<SessionMemorySelector["select"]>;
  initializeSession(input: SessionInitInput, ctx: RequestContext): Promise<void>;
  executionDeadlineMs(settings: SandboxSettings): number;
}

/** Assemble and initialize a claimed automation session using its admitted authority and target. */
export class AutomationSessionService {
  constructor(private readonly deps: AutomationSessionServiceDeps) {}

  async create(input: CreateAutomationSessionInput): Promise<void> {
    const { automation, run, providerAuth, sessionId, executionPrincipal, startedAtMs, admission } =
      input;
    const ctx = this.deps.createRequestContext(automation, run);
    if (automation.owner_team_id !== null && !admission.target) {
      throw new Error("Team automation launch is missing its admitted target");
    }
    const target = admission.target ?? (await this.deps.resolveTarget(run, ctx));

    // Session-scoped integration settings resolve from the primary member
    // (design §6.2), with environment-bound runs layering that environment's
    // overrides on top (design §13.5) — same rules as handleCreateSession.
    const scopeMembers =
      target.repositories ??
      (target.repoOwner && target.repoName
        ? [{ repoOwner: target.repoOwner, repoName: target.repoName, repoId: target.repoId }]
        : []);
    const { codeServerEnabled, vncEnabled, sandboxSettings } = await this.deps.resolveSettings(
      scopeMembers,
      target.environmentId
    );
    // The session below is about to start spending this budget, so the sweep
    // must not come for the run until it is spent.
    await this.deps.store.setRunExecutionDeadline(
      run.id,
      startedAtMs + this.deps.executionDeadlineMs(sandboxSettings)
    );
    // Automation runs use all target-applicable shared skills. Personal
    // profiles are interactive-user choices and are not automation policy.
    const managedSkillsManifest = await this.deps.resolveSkills(
      {
        repositories: scopeMembers,
        environmentId: target.environmentId,
      },
      { mode: "all" },
      executionPrincipal.platformUserId
    );

    const scmEnrichment = executionPrincipal.scmEnrichment;

    // Re-authorize with admission's requirements, and re-read the team's current policy, as the
    // last step before creation: the principal may have left the team, been suspended, or lost a
    // permission, and the team's default visibility may have changed since admission.
    const [team, authorized] = await Promise.all([
      automation.owner_team_id === null ? null : this.deps.teams.getById(automation.owner_team_id),
      this.deps.isAuthorized(admission.authorization),
    ]);
    if (!authorized) throw new AutomationExecutionUnauthorizedError(executionDenialReason(team));

    // Personal memory serves its owner's own prompts, and nobody prompts an automation run,
    // whoever triggered it; like personal skill profiles, it stays out.
    const memorySelection = await this.deps.selectMemory(ctx, {
      principal: {
        userId: executionPrincipal.platformUserId,
        ownerTeamId: automation.owner_team_id,
      },
      repositories: scopeMembers,
      environmentId: target.environmentId,
      includePersonalMemories: false,
    });

    const sessionInput: SessionInitInput = {
      memory: resolvedPin(memorySelection),
      ownerTeamId: automation.owner_team_id,
      visibility: team?.defaultVisibility ?? "workspace",
      sessionId,
      ...target,
      title: `[Auto] ${automation.name}`,
      harness: getValidHarnessOrDefault(automation.harness),
      model: automation.model,
      reasoningEffort: automation.reasoning_effort,
      participantUserId: executionPrincipal.participantUserId,
      platformUserId: executionPrincipal.platformUserId,
      participantCanonicalUserId: executionPrincipal.platformUserId,
      scmUserId: scmEnrichment?.scmUserId,
      scmLogin: scmEnrichment?.scmLogin,
      scmName: scmEnrichment?.displayName,
      scmEmail: scmEnrichment?.email,
      codeServerEnabled,
      vncEnabled,
      sandboxSettings,
      spawnSource: "automation",
      spawnDepth: 0,
      automationId: automation.id,
      automationRunId: run.id,
      managedSkills: resolvedPin(managedSkillsManifest),
      providerAuth,
    };

    await this.deps.initializeSession(sessionInput, ctx);
  }
}
