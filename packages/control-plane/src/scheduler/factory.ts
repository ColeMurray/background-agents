import { getUserAuth } from "../auth/user/runtime";
import { GitHubAttributionUnavailableError } from "../source-control/github-credential-authority";
import { UserStore } from "../db/user-store";
import {
  AmbiguousGitHubIdentityError,
  resolveGitHubEnrichmentForCanonicalUser,
  type GitHubEnrichment,
} from "../session/identity";
import { resolveScmProviderFromEnv } from "../source-control/config";
import { resolveAutomationRepositories } from "../automation/repository";
import { AutomationInvocationService } from "./invocation-service";
import { AutomationFailureService } from "./failure-service";
import { AutomationRecoveryService } from "./recovery-service";
import { computeHmacHex } from "@open-inspect/shared/auth";
import { callbackSigningSecret } from "../auth/service/callback-signing";
import { AutomationStore } from "../db/automation-store";
import { IntegrationSettingsStore } from "../db/integration-settings";
import { SessionIndexStore } from "../db/session-index";
import type { SqlDatabase } from "../db/sql-database";
import { TeamChannelBindingStore } from "../db/team-channel-bindings";
import { createLogger, parseLogLevel } from "../logger";
import type { BackgroundTasks } from "../platform-ports";
import { retryDelivery } from "../session/callback-delivery";
import type { Env } from "../types";
import { Scheduler } from "./scheduler";
import { AutomationSlackService } from "./slack-service";
import { generateId } from "../auth/crypto";
import { isAutomationExecutionAuthorized } from "../automation/authorization-guard";
import { resolveAutomationSessionTarget } from "../automation/session-target";
import { createRequestMetrics } from "../db/instrumented-sql-database";
import { TeamRepositoryGrantStore } from "../db/team-repository-grants";
import { TeamStore } from "../db/teams";
import { validateHarnessExecution } from "../harness-admission";
import { createSessionMemorySelector } from "../memory/session-memory-selector-factory";
import { initializeSession } from "../session/initialize";
import { resolveSessionScopedSettings } from "../session/integration-settings-resolution";
import { resolveManagedSkills } from "../session/skill-resolution";
import {
  AutomationSessionService,
  type AutomationSessionServiceDeps,
} from "./automation-session-service";
import {
  resolveAutomationProviderAuth,
  resolveProviderAuthSnapshot,
  resolveTeamTargets,
  type LaunchAdmissionDeps,
  type LaunchAdmissionOperations,
} from "./launch-admission";
import { executionDeadlineMs } from "./launch-policy";
import { AutomationRunLaunchService } from "./run-launch-service";
import { releaseHeldPrompts } from "./session-continuity";
import { enqueueAutomationFirstPrompt } from "./session-prompt";

/** Assemble scheduler collaborators without starting database or network work. */
export function createScheduler(
  db: SqlDatabase,
  env: Env,
  backgroundJobs: BackgroundTasks
): Scheduler {
  const log = createLogger("scheduler", {}, parseLogLevel(env.LOG_LEVEL));
  const sessionIndex = new SessionIndexStore(db);
  const store = new AutomationStore(db);
  const teams = new TeamStore(db);
  const channels = new TeamChannelBindingStore(db);
  const slack = new AutomationSlackService({
    bot: env.SLACK_BOT,
    signingSecret: callbackSigningSecret(env, "slack-bot"),
    automations: store,
    settings: new IntegrationSettingsStore(db),
    postScope: {
      getSession: (sessionId) => sessionIndex.get(sessionId),
      getChannelBinding: (channelId) => channels.get("slack", channelId),
    },
    sign: computeHmacHex,
    retryDelivery,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    nowMs: () => Date.now(),
    log,
  });
  const createRequestContext: AutomationSessionServiceDeps["createRequestContext"] = (
    automation,
    run
  ) => ({
    trace_id: `automation:${automation.id}`,
    request_id: run.id,
    metrics: createRequestMetrics(),
    db,
    executionCtx: backgroundJobs,
  });
  const resolveDeadlineMs: AutomationSessionServiceDeps["executionDeadlineMs"] = (settings) =>
    executionDeadlineMs(settings, env);
  const sessions = new AutomationSessionService({
    store,
    createRequestContext,
    resolveTarget: (run, ctx) => resolveAutomationSessionTarget(env, run, ctx, log),
    resolveSettings: (members, environmentId) =>
      resolveSessionScopedSettings(db, members, environmentId),
    resolveSkills: (target, selection, userId) =>
      resolveManagedSkills(db, target, selection, userId),
    teams,
    isAuthorized: (request) => isAutomationExecutionAuthorized(db, request),
    selectMemory: (ctx, request) => createSessionMemorySelector(ctx).select(request),
    initializeSession: async (input, ctx) => {
      await initializeSession(env, input, ctx);
    },
    executionDeadlineMs: resolveDeadlineMs,
  });
  const launcher = new AutomationRunLaunchService({
    store,
    sessions,
    enqueueFirstPrompt: (input) => enqueueAutomationFirstPrompt(env, input),
    releaseHeldPrompts: (run) => releaseHeldPrompts({ store, env, log, db, backgroundJobs }, run),
    executionDeadlineMs: resolveDeadlineMs,
    nowMs: () => Date.now(),
    newId: generateId,
    log,
  });
  const admissionDeps: LaunchAdmissionDeps = {
    resolveTarget: (automation, run) =>
      resolveAutomationSessionTarget(env, run, createRequestContext(automation, run), log),
    grants: new TeamRepositoryGrantStore(db),
    resolveProviderAuth: (automationId, harness) =>
      resolveAutomationProviderAuth(db, automationId, harness),
    validateHarness: (input, modes) => validateHarnessExecution(db, input, modes),
  };
  const admission: LaunchAdmissionOperations = {
    resolveTeamTargets: (automation, team, candidates) =>
      resolveTeamTargets(admissionDeps, automation, team, candidates),
    resolveProviderAuth: (automation) => resolveProviderAuthSnapshot(admissionDeps, automation),
  };
  const resolveScmEnrichment = async (userId: string): Promise<GitHubEnrichment | null> => {
    if (resolveScmProviderFromEnv(env.SCM_PROVIDER) !== "github") return null;
    try {
      return await resolveGitHubEnrichmentForCanonicalUser(
        new UserStore(db),
        userId,
        () => getUserAuth(env, db).api
      );
    } catch (error) {
      if (
        !(error instanceof AmbiguousGitHubIdentityError) &&
        !(error instanceof GitHubAttributionUnavailableError)
      )
        throw error;
      log.warn("GitHub attribution unavailable; continuing without it", {
        event: "scheduler.github_enrichment_unavailable",
        user_id: userId,
        error,
      });
      return null;
    }
  };
  const failures = new AutomationFailureService(store, log);
  const invocations = new AutomationInvocationService({
    store,
    teams,
    admission,
    launcher,
    failures,
    resolveScmEnrichment,
    isAuthorized: (request) => isAutomationExecutionAuthorized(db, request),
    resolveRepositories: (repositories) => resolveAutomationRepositories(env, repositories),
    nowMs: () => Date.now(),
    newId: generateId,
    log,
  });
  const recovery = new AutomationRecoveryService({
    store,
    failures,
    executionDeadlineMs: resolveDeadlineMs,
    nowMs: () => Date.now(),
    log,
  });
  return new Scheduler({
    db,
    env,
    backgroundJobs,
    slack,
    log,
    invocations,
    failures,
    recovery,
    resolveScmEnrichment,
  });
}
