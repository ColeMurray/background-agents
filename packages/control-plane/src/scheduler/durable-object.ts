/**
 * SchedulerDO — singleton Durable Object that processes scheduled automations.
 *
 * Woken by the Worker's `scheduled()` handler (cron trigger) or by manual
 * trigger requests from the automation CRUD routes. Handles:
 * - Tick: recovery sweep + process overdue automations
 * - Trigger: manual single-automation trigger
 * - RunComplete: callback from SessionDO on execution completion
 */

import { DurableObject } from "cloudflare:workers";
import {
  nextCronOccurrence,
  matchesConditions,
  conditionRegistry,
  computeHmacHex,
  DEFAULT_MAX_RUNS_PER_HOUR,
  type AutomationCallbackContext,
  type AutomationEvent,
  type SlackAutomationEvent,
  type TriggerConfig,
} from "@open-inspect/shared";
import {
  AutomationStore,
  toAutomationRun,
  isDuplicateKeyError,
  type AutomationRow,
  type AutomationRunRow,
  type SlackRunColumns,
} from "../db/automation-store";
import { buildSlackCompletionNotification, buildSlackSkipNotification } from "./slack-completion";
import { UserStore } from "../db/user-store";
import { createRequestMetrics } from "../db/instrumented-d1";
import { generateId } from "../auth/crypto";
import { createLogger, parseLogLevel } from "../logger";
import type { Logger } from "../logger";
import type { Env } from "../types";
import { initializeSession } from "../session/initialize";
import {
  resolveCodeServerEnabled,
  resolveSandboxSettings,
} from "../session/integration-settings-resolution";

/** Max automations to process per tick (backpressure). */
const MAX_PER_TICK = 25;

/** Threshold for detecting orphaned "starting" runs (5 minutes). */
const ORPHAN_THRESHOLD_MS = 5 * 60 * 1000;

/** Default execution timeout for detecting timed-out runs (90 minutes). */
const DEFAULT_EXECUTION_TIMEOUT_MS = 90 * 60 * 1000;

/** Consecutive failure threshold for auto-pause. */
const AUTO_PAUSE_THRESHOLD = 3;

/** Rate-limit window for slack triggers (1 hour, matching max_runs_per_hour). */
const SLACK_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

export class SchedulerDO extends DurableObject<Env> {
  private readonly log: Logger;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.log = createLogger("scheduler-do", {}, parseLogLevel(env.LOG_LEVEL));
  }

  /**
   * Mark a run as failed and increment consecutive failures for the automation.
   * If the failure count reaches AUTO_PAUSE_THRESHOLD, auto-pause the automation.
   */
  private async failRunAndTrack(
    store: AutomationStore,
    runId: string,
    automationId: string,
    reason: string
  ): Promise<void> {
    await store.updateRun(runId, {
      status: "failed",
      failure_reason: reason,
      completed_at: Date.now(),
    });

    const count = await store.incrementConsecutiveFailures(automationId);
    if (count >= AUTO_PAUSE_THRESHOLD) {
      await store.autoPause(automationId);
      this.log.warn("Automation auto-paused due to consecutive failures", {
        event: "scheduler.auto_pause",
        automation_id: automationId,
        consecutive_failures: count,
      });
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "POST" && path === "/internal/tick") {
      return this.handleTick();
    }
    if (request.method === "POST" && path === "/internal/trigger") {
      return this.handleTrigger(request);
    }
    if (request.method === "POST" && path === "/internal/event") {
      return this.handleEvent(request);
    }
    if (request.method === "POST" && path === "/internal/run-complete") {
      return this.handleRunComplete(request);
    }
    if (request.method === "GET" && path === "/internal/health") {
      return this.handleHealth();
    }

    return new Response("Not Found", { status: 404 });
  }

  // ─── Tick handler ────────────────────────────────────────────────────────

  private async handleTick(): Promise<Response> {
    const store = new AutomationStore(this.env.DB);
    const now = Date.now();
    let processed = 0;
    let skipped = 0;
    let failed = 0;

    // 1. Recovery sweep
    await this.recoverySweep(store);

    // 2. Process overdue automations
    const overdue = await store.getOverdueAutomations(now, MAX_PER_TICK);

    for (const automation of overdue) {
      try {
        // Concurrency check — advance next_run_at to avoid repeat skip inserts
        const activeRun = await store.getActiveRunForAutomation(automation.id);
        if (activeRun) {
          const nextRunAt = nextCronOccurrence(
            automation.schedule_cron!,
            automation.schedule_tz
          ).getTime();
          const skipRunId = generateId();
          await store.insertRun({
            id: skipRunId,
            automation_id: automation.id,
            session_id: null,
            status: "skipped",
            skip_reason: "concurrent_run_active",
            failure_reason: null,
            scheduled_at: automation.next_run_at!,
            started_at: null,
            completed_at: now,
            created_at: now,
            trigger_key: null,
            concurrency_key: null,
          });
          await store.update(automation.id, { next_run_at: nextRunAt });
          skipped++;
          continue;
        }

        // Compute next run time
        const nextRunAt = nextCronOccurrence(
          automation.schedule_cron!,
          automation.schedule_tz
        ).getTime();

        // Atomic: create run + advance schedule
        const runId = generateId();
        await store.createRunAndAdvanceSchedule(
          {
            id: runId,
            automation_id: automation.id,
            session_id: null,
            status: "starting",
            skip_reason: null,
            failure_reason: null,
            scheduled_at: automation.next_run_at!,
            started_at: null,
            completed_at: null,
            created_at: now,
            trigger_key: null,
            concurrency_key: null,
          },
          automation.id,
          nextRunAt
        );

        // Create session + send prompt
        try {
          const { sessionId } = await this.createSessionForAutomation(automation, runId);

          await this.sendPromptToSession(sessionId, automation, runId);

          // Update run to running
          await store.updateRun(runId, {
            status: "running",
            session_id: sessionId,
            started_at: Date.now(),
          });

          processed++;
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          this.log.error("Failed to create session for automation", {
            event: "scheduler.session_creation_failed",
            automation_id: automation.id,
            run_id: runId,
            error: message,
          });

          await this.failRunAndTrack(store, runId, automation.id, message);

          failed++;
        }
      } catch (e) {
        this.log.error("Unexpected error processing automation", {
          event: "scheduler.tick_error",
          automation_id: automation.id,
          error: e instanceof Error ? e.message : String(e),
        });
        failed++;
      }
    }

    this.log.info("Tick completed", {
      event: "scheduler.tick_complete",
      processed,
      skipped,
      failed,
      overdue_count: overdue.length,
    });

    return new Response(JSON.stringify({ processed, skipped, failed }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // ─── Recovery sweep ──────────────────────────────────────────────────────

  private async recoverySweep(store: AutomationStore): Promise<void> {
    // Orphaned starting runs (session creation never completed)
    const orphaned = await store.getOrphanedStartingRuns(ORPHAN_THRESHOLD_MS);
    for (const run of orphaned) {
      this.log.warn("Recovering orphaned starting run", {
        event: "scheduler.recovery.orphaned",
        run_id: run.id,
        automation_id: run.automation_id,
      });

      await this.failRunAndTrack(store, run.id, run.automation_id, "session_creation_timeout");
    }

    // Timed-out running runs
    const executionTimeoutMs = parseInt(
      this.env.EXECUTION_TIMEOUT_MS || String(DEFAULT_EXECUTION_TIMEOUT_MS),
      10
    );
    const timedOut = await store.getTimedOutRunningRuns(executionTimeoutMs);
    for (const run of timedOut) {
      this.log.warn("Recovering timed-out running run", {
        event: "scheduler.recovery.timed_out",
        run_id: run.id,
        automation_id: run.automation_id,
      });

      await this.failRunAndTrack(store, run.id, run.automation_id, "execution_timeout");
    }
  }

  // ─── Event handler ───────────────────────────────────────────────────────

  private async handleEvent(request: Request): Promise<Response> {
    const event = (await request.json()) as AutomationEvent;
    const store = new AutomationStore(this.env.DB);

    // 1. Find matching automations
    let candidates: AutomationRow[];
    switch (event.source) {
      case "webhook": {
        const automation = await store.getById(event.automationId);
        candidates =
          automation && automation.enabled === 1 && !automation.deleted_at ? [automation] : [];
        break;
      }
      case "sentry": {
        const automation = await store.getById(event.automationId);
        candidates =
          automation &&
          automation.enabled === 1 &&
          !automation.deleted_at &&
          automation.event_type === event.eventType
            ? [automation]
            : [];
        break;
      }
      case "github":
      case "linear":
        candidates = await store.getAutomationsForEvent(
          event.repoOwner,
          event.repoName,
          event.source === "github" ? "github_event" : "linear_event",
          event.eventType
        );
        break;
      case "slack":
        candidates = await store.getSlackAutomationsForChannel(event.channelId);
        break;
    }

    let triggered = 0;
    let skipped = 0;
    // Surface at most one concurrency-skip ephemeral per event, even when
    // several automations watch the same thread and all skip.
    let concurrencySkipped = false;

    for (const automation of candidates) {
      const now = Date.now();

      // 2. Evaluate conditions
      const config: TriggerConfig = automation.trigger_config
        ? JSON.parse(automation.trigger_config)
        : { conditions: [] };
      if (!matchesConditions(config.conditions, event, conditionRegistry)) {
        continue;
      }

      // 3. Rate limit (slack only) — bounds the top-level-post flood that the
      // per-thread concurrency_key does not. Records a skip for observability.
      if (event.source === "slack") {
        const maxRuns = automation.max_runs_per_hour ?? DEFAULT_MAX_RUNS_PER_HOUR;
        const recentRuns = await store.countRunsInWindow(
          automation.id,
          now - SLACK_RATE_LIMIT_WINDOW_MS
        );
        if (recentRuns >= maxRuns) {
          await this.recordSlackSkip(store, automation.id, event, "rate_limited");
          skipped++;
          continue;
        }
      }

      // 4. Concurrency check (per-event-instance)
      const activeRun = await store.getActiveRunForKey(automation.id, event.concurrencyKey);
      if (activeRun) {
        // For slack, persist the skip so the bot can surface "a run is already
        // active for this thread" and so the drop is auditable.
        if (event.source === "slack") {
          await this.recordSlackSkip(store, automation.id, event, "concurrent_run_active");
          concurrencySkipped = true;
        }
        skipped++;
        continue;
      }

      // 5. Create run (dedup via unique index on trigger_key)
      const runId = generateId();
      try {
        await store.insertRun({
          id: runId,
          automation_id: automation.id,
          session_id: null,
          status: "starting",
          skip_reason: null,
          failure_reason: null,
          scheduled_at: now,
          started_at: null,
          completed_at: null,
          created_at: now,
          trigger_key: event.triggerKey,
          concurrency_key: event.concurrencyKey,
          ...(event.source === "slack" ? slackRunColumns(event) : {}),
        });
      } catch (e) {
        if (isDuplicateKeyError(e)) {
          skipped++;
          continue;
        }
        throw e;
      }

      // 5. Create session + send prompt (with event context prepended)
      try {
        const instructions = `${event.contextBlock}\n---\n\n${automation.instructions}`;
        const { sessionId } = await this.createSessionForAutomation(automation, runId);
        await this.sendPromptToSession(sessionId, automation, runId, instructions);

        await store.updateRun(runId, {
          status: "running",
          session_id: sessionId,
          started_at: Date.now(),
        });

        triggered++;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        await this.failRunAndTrack(store, runId, automation.id, message);
      }
    }

    if (event.source === "slack" && concurrencySkipped) {
      await this.notifySlackConcurrencySkip(event);
    }

    this.log.info("Event processed", {
      event: "scheduler.event_processed",
      source: event.source,
      event_type: event.eventType,
      trigger_key: event.triggerKey,
      triggered,
      skipped,
      candidates: candidates.length,
    });

    return new Response(JSON.stringify({ triggered, skipped }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // ─── Manual trigger ──────────────────────────────────────────────────────

  private async handleTrigger(request: Request): Promise<Response> {
    const body = (await request.json()) as { automationId: string };
    const { automationId } = body;

    if (!automationId) {
      return new Response(JSON.stringify({ error: "automationId required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const store = new AutomationStore(this.env.DB);
    const automation = await store.getById(automationId);
    if (!automation) {
      return new Response(JSON.stringify({ error: "Automation not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Concurrency check
    const activeRun = await store.getActiveRunForAutomation(automationId);
    if (activeRun) {
      return new Response(JSON.stringify({ error: "An active run already exists" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      });
    }

    const now = Date.now();
    const runId = generateId();

    // Create run record (no schedule advance for manual trigger)
    await store.insertRun({
      id: runId,
      automation_id: automationId,
      session_id: null,
      status: "starting",
      skip_reason: null,
      failure_reason: null,
      scheduled_at: now,
      started_at: null,
      completed_at: null,
      created_at: now,
      trigger_key: null,
      concurrency_key: null,
    });

    try {
      const { sessionId } = await this.createSessionForAutomation(automation, runId);

      await this.sendPromptToSession(sessionId, automation, runId);

      await store.updateRun(runId, {
        status: "running",
        session_id: sessionId,
        started_at: Date.now(),
      });

      const run = await store.getRunById(automationId, runId);

      this.log.info("Manual trigger succeeded", {
        event: "scheduler.manual_trigger",
        automation_id: automationId,
        run_id: runId,
        session_id: sessionId,
      });

      return new Response(JSON.stringify({ run: run ? toAutomationRun(run) : { id: runId } }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);

      await this.failRunAndTrack(store, runId, automationId, message);

      this.log.error("Manual trigger failed", {
        event: "scheduler.manual_trigger_failed",
        automation_id: automationId,
        run_id: runId,
        error: message,
      });

      return new Response(JSON.stringify({ error: "Failed to trigger automation" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  // ─── Run complete callback ───────────────────────────────────────────────

  private async handleRunComplete(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      automationId: string;
      runId: string;
      sessionId: string;
      success: boolean;
      error?: string;
    };

    const store = new AutomationStore(this.env.DB);

    // Verify the run exists and is still in an active state.
    // The recovery sweep may have already marked it as failed.
    const run = await store.getRunById(body.automationId, body.runId);
    if (!run || (run.status !== "starting" && run.status !== "running")) {
      this.log.warn("Ignoring run-complete callback for non-active run", {
        event: "scheduler.run_complete_ignored",
        automation_id: body.automationId,
        run_id: body.runId,
        current_status: run?.status ?? "not_found",
      });
      return new Response(JSON.stringify({ ok: true, ignored: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (body.success) {
      await store.updateRun(body.runId, {
        status: "completed",
        completed_at: Date.now(),
      });
      await store.resetConsecutiveFailures(body.automationId);

      this.log.info("Run completed successfully", {
        event: "scheduler.run_complete",
        automation_id: body.automationId,
        run_id: body.runId,
        session_id: body.sessionId,
      });
    } else {
      await this.failRunAndTrack(
        store,
        body.runId,
        body.automationId,
        body.error || "Unknown error"
      );

      this.log.warn("Run completed with failure", {
        event: "scheduler.run_failed",
        automation_id: body.automationId,
        run_id: body.runId,
        session_id: body.sessionId,
        error: body.error,
      });
    }

    // Slack-triggered runs deliver their result back into the originating
    // thread. The scheduler owns this fan-out (not the session callback path)
    // because the thread coordinates live on the run row. Best-effort.
    if (run.slack_channel) {
      await this.notifySlackCompletion(
        store,
        run,
        body.success,
        body.success ? undefined : body.error
      );
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  /**
   * Persist a `skipped` run for a slack event dropped by the rate-limit or
   * concurrency guard, carrying the same thread coordinates a materialized run
   * would. Best-effort observability; `recordSkippedRun` swallows the unexpected
   * duplicate-key case internally.
   */
  private async recordSlackSkip(
    store: AutomationStore,
    automationId: string,
    event: SlackAutomationEvent,
    reason: string
  ): Promise<void> {
    await store.recordSkippedRun({
      id: generateId(),
      automationId,
      skipReason: reason,
      concurrencyKey: event.concurrencyKey,
      slackColumns: slackRunColumns(event),
    });
  }

  /**
   * Post a Slack-triggered run's result into its originating thread by calling
   * the slack-bot's `/callbacks/automation-complete` endpoint. Signs the body
   * with `INTERNAL_CALLBACK_SECRET` (in-body HMAC, matching the bot's other
   * callbacks). No-ops when the run has no thread anchor, when `SLACK_BOT` is
   * unbound, or when the secret is unset — all best-effort.
   */
  private async notifySlackCompletion(
    store: AutomationStore,
    run: AutomationRunRow,
    success: boolean,
    error?: string
  ): Promise<void> {
    const binding = this.env.SLACK_BOT;
    const secret = this.env.INTERNAL_CALLBACK_SECRET;
    if (!binding || !secret) return;

    const automation = await store.getById(run.automation_id);
    const body = buildSlackCompletionNotification({
      run,
      automationName: automation?.name ?? "Automation",
      success,
      error,
    });
    if (!body) return;

    try {
      const signature = await computeHmacHex(JSON.stringify(body), secret);
      const response = await binding.fetch("https://internal/callbacks/automation-complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, signature }),
      });
      if (!response.ok) {
        this.log.warn("Slack completion callback failed", {
          event: "scheduler.slack_complete_failed",
          automation_id: run.automation_id,
          run_id: run.id,
          http_status: response.status,
        });
      }
    } catch (e) {
      this.log.warn("Slack completion callback errored", {
        event: "scheduler.slack_complete_failed",
        automation_id: run.automation_id,
        run_id: run.id,
        error: e instanceof Error ? e : new Error(String(e)),
      });
    }
  }

  /**
   * Post a best-effort ephemeral "a run is already active for this thread"
   * notice to the message author when a slack event is dropped by the
   * per-thread concurrency guard. No-ops without a binding/secret/actor.
   */
  private async notifySlackConcurrencySkip(event: SlackAutomationEvent): Promise<void> {
    const binding = this.env.SLACK_BOT;
    const secret = this.env.INTERNAL_CALLBACK_SECRET;
    if (!binding || !secret) return;

    const body = buildSlackSkipNotification({
      channelId: event.channelId,
      actorUserId: event.actorUserId,
      threadTs: event.threadTs,
      ts: event.ts,
    });
    if (!body) return;

    try {
      const signature = await computeHmacHex(JSON.stringify(body), secret);
      await binding.fetch("https://internal/callbacks/automation-skip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, signature }),
      });
    } catch (e) {
      this.log.warn("Slack skip callback errored", {
        event: "scheduler.slack_skip_failed",
        channel: event.channelId,
        error: e instanceof Error ? e : new Error(String(e)),
      });
    }
  }

  // ─── Health check ────────────────────────────────────────────────────────

  private async handleHealth(): Promise<Response> {
    const store = new AutomationStore(this.env.DB);
    const overdueCount = await store.countOverdue(Date.now());

    return new Response(
      JSON.stringify({
        status: "healthy",
        overdueCount,
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  // ─── Session creation ────────────────────────────────────────────────────

  private async createSessionForAutomation(
    automation: AutomationRow,
    runId: string
  ): Promise<{ sessionId: string }> {
    const sessionId = generateId();

    // Resolve the canonical user_id for the session index.
    // Automations created through the web UI populate user_id at creation time
    // (handleCreateAutomation resolves it for both GitHub and Google users), so this
    // lookup is skipped for them. The fallback below only covers legacy rows with
    // user_id = NULL: those predate Google login and store the GitHub numeric user ID
    // in created_by (from NextAuth session.user.id), so a github-only identity lookup
    // recovers the canonical user. It becomes dead code once legacy rows are backfilled.
    let userId = automation.user_id;
    if (!userId && automation.created_by && automation.created_by !== "anonymous") {
      try {
        const userStore = new UserStore(this.env.DB);
        const identity = await userStore.getIdentity("github", automation.created_by);
        if (identity) {
          userId = identity.userId;
        }
      } catch {
        // Best-effort — proceed without user_id
      }
    }

    const [codeServerEnabled, sandboxSettings] = await Promise.all([
      resolveCodeServerEnabled(this.env.DB, automation.repo_owner, automation.repo_name),
      resolveSandboxSettings(this.env.DB, automation.repo_owner, automation.repo_name),
    ]);

    await initializeSession(
      this.env,
      {
        sessionId,
        repoOwner: automation.repo_owner,
        repoName: automation.repo_name,
        repoId: automation.repo_id,
        defaultBranch: automation.base_branch,
        title: `[Auto] ${automation.name}`,
        model: automation.model,
        reasoningEffort: automation.reasoning_effort,
        participantUserId: automation.created_by,
        platformUserId: userId,
        scmTokenEncrypted: null,
        scmRefreshTokenEncrypted: null,
        codeServerEnabled,
        sandboxSettings,
        spawnSource: "automation",
        spawnDepth: 0,
        automationId: automation.id,
        automationRunId: runId,
      },
      {
        trace_id: `automation:${automation.id}`,
        request_id: runId,
        metrics: createRequestMetrics(),
      }
    );

    return { sessionId };
  }

  private async sendPromptToSession(
    sessionId: string,
    automation: AutomationRow,
    runId: string,
    instructionsOverride?: string
  ): Promise<void> {
    const doId = this.env.SESSION.idFromName(sessionId);
    const stub = this.env.SESSION.get(doId);

    const callbackContext: AutomationCallbackContext = {
      source: "automation",
      automationId: automation.id,
      runId,
      automationName: automation.name,
    };

    const promptResponse = await stub.fetch("http://internal/internal/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: instructionsOverride ?? automation.instructions,
        authorId: automation.created_by,
        source: "automation",
        callbackContext,
      }),
    });

    if (!promptResponse.ok) {
      throw new Error(`Prompt enqueue failed with status ${promptResponse.status}`);
    }
  }
}

/** Run-row slack columns for a slack-origin event — shared by insertRun and recordSkippedRun. */
function slackRunColumns(event: SlackAutomationEvent): SlackRunColumns {
  return {
    slack_channel: event.channelId,
    slack_thread_ts: event.threadTs ?? null,
    slack_message_ts: event.ts,
    actor_user_id: event.actorUserId,
  };
}
