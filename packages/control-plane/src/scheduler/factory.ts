import { AuthorizationService } from "../authorization/service";
import { UserStore } from "../db/user-store";
import { AutomationAttributionService } from "./attribution-service";
import { SessionContinuityService } from "./session-continuity-service";
import * as schedulerCrypto from "../auth/crypto";
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
import { resolveAutomationProviderAuth } from "./launch-admission";
import { AutomationLaunchAdmissionService } from "./launch-admission-service";
import { executionDeadlineMs } from "./launch-policy";
import { AutomationRunLaunchService } from "./run-launch-service";
import { AutomationEventHandler } from "./event-handler";
import { SlackContinuationPolicyFactory } from "./slack-continuation-policy";
import { WebhookContinuationPolicyFactory } from "./webhook-continuation-policy";
import { SlackEventHandler } from "./slack-event-handler";
import { WebhookEventHandler } from "./webhook-event-handler";
import { SlackChannelStore } from "../db/slack-channel-store";
import { admitGitHubEvent } from "../automation/github-event-admission";
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
  const users = new UserStore(db);
  const scmProvider = resolveScmProviderFromEnv(env.SCM_PROVIDER);
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
    clock: Date,
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
  const continuity = new SessionContinuityService({
    store,
    env,
    log,
    db,
    backgroundJobs,
    authorization: new AuthorizationService(db),
    clock: Date,
    crypto: schedulerCrypto,
  });
  const launcher = new AutomationRunLaunchService({
    store,
    sessions,
    enqueueFirstPrompt: (input) => enqueueAutomationFirstPrompt(env, input),
    continuity,
    executionDeadlineMs: resolveDeadlineMs,
    clock: Date,
    crypto: schedulerCrypto,
    log,
  });
  const admission = new AutomationLaunchAdmissionService({
    resolveTarget: (automation, run) =>
      resolveAutomationSessionTarget(env, run, createRequestContext(automation, run), log),
    grants: new TeamRepositoryGrantStore(db),
    resolveProviderAuth: (automationId, harness) =>
      resolveAutomationProviderAuth(db, automationId, harness),
    validateHarness: (input, modes) => validateHarnessExecution(db, input, modes),
  });
  const attribution = new AutomationAttributionService({ users, scmProvider, db, env, log });
  const failures = new AutomationFailureService(store, log);
  const invocations = new AutomationInvocationService({
    store,
    teams,
    admission,
    launcher,
    failures,
    attribution,
    isAuthorized: (request) => isAutomationExecutionAuthorized(db, request),
    resolveRepositories: (repositories) => resolveAutomationRepositories(env, repositories),
    clock: Date,
    crypto: schedulerCrypto,
    log,
  });
  const recovery = new AutomationRecoveryService({
    store,
    failures,
    executionDeadlineMs: resolveDeadlineMs,
    clock: Date,
    log,
  });
  const slackEvents = new SlackEventHandler({
    channels: new SlackChannelStore(db),
    slack,
    invocations,
    continuity,
    policies: new SlackContinuationPolicyFactory({ users, continuity, attribution, scmProvider }),
    clock: Date,
    log,
  });
  const webhookEvents = new WebhookEventHandler({
    store,
    invocations,
    continuity,
    policies: new WebhookContinuationPolicyFactory({
      store,
      continuity,
      clock: Date,
      crypto: schedulerCrypto,
    }),
    crypto: schedulerCrypto,
    clock: Date,
    log,
  });
  const events = new AutomationEventHandler({
    store,
    invocations,
    admitGitHubEvent: (event, fire) => admitGitHubEvent(db, event, fire, log),
    slack: slackEvents,
    webhook: webhookEvents,
    log,
  });
  return new Scheduler({
    store,
    events,
    continuity,
    clock: Date,
    crypto: schedulerCrypto,
    slack,
    log,
    invocations,
    failures,
    recovery,
  });
}
