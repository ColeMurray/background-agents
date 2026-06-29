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
  type AutomationCallbackContext,
  type AutomationEvent,
  type SlackAutomationEvent,
  type SlackCallbackContext,
  type TriggerConfig,
} from "@open-inspect/shared";
import {
  AutomationStore,
  toAutomationRun,
  isDuplicateKeyError,
  type AutomationRow,
  type AutomationRunRow,
} from "../db/automation-store";
import { SlackChannelStore } from "../db/slack-channel-store";
import {
  buildSlackCompletionNotification,
  buildSlackSkipNotification,
  getSlackRunMetadata,
  type SlackRunMetadata,
  type SlackCompletionContext,
} from "./slack-completion";
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

/** Max runs to recover per sweep type per tick (backpressure). */
const RECOVERY_SWEEP_LIMIT = 50;

/**
 * How long after a slack run's first trigger that thread replies keep continuing
 * the same session (matches the interactive thread→session KV TTL of 7 days). Steering
 * does not create new runs, so this is measured from the root run's `created_at` and
 * does not slide — a reply after the window forks a fresh run.
 */
const SLACK_THREAD_CONTINUITY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

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

  private async failRunAndTrackBestEffort(
    store: AutomationStore,
    runId: string,
    automationId: string,
    reason: string
  ): Promise<void> {
    try {
      await this.failRunAndTrack(store, runId, automationId, reason);
    } catch (trackingError) {
      this.log.error("Failed to track run failure", {
        event: "scheduler.fail_track_error",
        automation_id: automationId,
        run_id: runId,
        original_reason: reason,
        error: trackingError instanceof Error ? trackingError.message : String(trackingError),
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

          await this.failRunAndTrackBestEffort(store, runId, automation.id, message);

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
    const executionTimeoutMs = parseInt(
      this.env.EXECUTION_TIMEOUT_MS || String(DEFAULT_EXECUTION_TIMEOUT_MS),
      10
    );

    const [orphanedResult, timedOutResult] = await Promise.allSettled([
      store.getOrphanedStartingRuns(ORPHAN_THRESHOLD_MS, RECOVERY_SWEEP_LIMIT),
      store.getTimedOutRunningRuns(executionTimeoutMs, RECOVERY_SWEEP_LIMIT),
    ]);

    const orphaned = orphanedResult.status === "fulfilled" ? orphanedResult.value : [];
    const timedOut = timedOutResult.status === "fulfilled" ? timedOutResult.value : [];

    if (orphanedResult.status === "rejected") {
      this.log.error("Recovery sweep failed to query orphaned runs", {
        event: "scheduler.recovery.query_error",
        category: "orphaned",
        error:
          orphanedResult.reason instanceof Error
            ? orphanedResult.reason.message
            : String(orphanedResult.reason),
      });
    }

    if (timedOutResult.status === "rejected") {
      this.log.error("Recovery sweep failed to query timed-out runs", {
        event: "scheduler.recovery.query_error",
        category: "timed_out",
        error:
          timedOutResult.reason instanceof Error
            ? timedOutResult.reason.message
            : String(timedOutResult.reason),
      });
    }

    if (orphaned.length === 0 && timedOut.length === 0) return;

    for (const run of orphaned) {
      this.log.warn("Recovering orphaned starting run", {
        event: "scheduler.recovery.orphaned",
        run_id: run.id,
        automation_id: run.automation_id,
      });
    }
    for (const run of timedOut) {
      this.log.warn("Recovering timed-out running run", {
        event: "scheduler.recovery.timed_out",
        run_id: run.id,
        automation_id: run.automation_id,
      });
    }

    const now = Date.now();
    const recoveredRuns: AutomationRunRow[] = [];

    if (orphaned.length > 0) {
      try {
        await store.bulkFailRuns(
          orphaned.map((r) => r.id),
          "session_creation_timeout",
          now
        );
        recoveredRuns.push(...orphaned);
      } catch (e) {
        this.log.error("Recovery sweep failed to mark orphaned runs as failed", {
          event: "scheduler.recovery.bulk_fail_error",
          category: "orphaned",
          count: orphaned.length,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    if (timedOut.length > 0) {
      try {
        await store.bulkFailRuns(
          timedOut.map((r) => r.id),
          "execution_timeout",
          now
        );
        recoveredRuns.push(...timedOut);
      } catch (e) {
        this.log.error("Recovery sweep failed to mark timed-out runs as failed", {
          event: "scheduler.recovery.bulk_fail_error",
          category: "timed_out",
          count: timedOut.length,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    if (recoveredRuns.length === 0) return;

    const automationCounts = new Map<string, number>();
    for (const run of recoveredRuns) {
      automationCounts.set(run.automation_id, (automationCounts.get(run.automation_id) ?? 0) + 1);
    }

    let newCounts: Map<string, number>;
    try {
      newCounts = await store.bulkIncrementFailures(automationCounts);
    } catch (e) {
      this.log.error("Recovery sweep failed to track failures", {
        event: "scheduler.recovery.bulk_track_error",
        error: e instanceof Error ? e.message : String(e),
      });
      return;
    }

    for (const [automationId, count] of newCounts) {
      if (count < AUTO_PAUSE_THRESHOLD) continue;

      try {
        await store.autoPause(automationId);
        this.log.warn("Automation auto-paused due to consecutive failures", {
          event: "scheduler.auto_pause",
          automation_id: automationId,
          consecutive_failures: count,
        });
      } catch (e) {
        this.log.error("Recovery sweep failed to auto-pause automation", {
          event: "scheduler.recovery.auto_pause_error",
          automation_id: automationId,
          consecutive_failures: count,
          error: e instanceof Error ? e.message : String(e),
        });
      }
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
        candidates = await new SlackChannelStore(this.env.DB).getSlackAutomationsForChannel(
          event.channelId
        );
        break;
    }

    let triggered = 0;
    let skipped = 0;
    // Follow-ups routed into an already-active thread's session (slack steering).
    let steered = 0;
    // Surface at most one concurrency-skip ephemeral per event, even when
    // several automations watch the same thread and all skip.
    let concurrencySkipped = false;

    for (const automation of candidates) {
      const now = Date.now();

      // Slack thread continuity — mirrors the interactive @mention path: any reply
      // in a thread that already has a session (any run status, within the
      // continuity window) continues that session, regardless of trigger
      // conditions. A reply is a steer, not a new trigger: a natural reply ("also
      // do X") won't contain the keyword that started the run, and a reply after
      // the run finished should still land in the same session. Its reply posts
      // back in-thread via the slack completion callback, exactly like an
      // interactive follow-up.
      if (event.source === "slack") {
        const steerable = await store.getLatestSteerableRunForThread(
          automation.id,
          event.concurrencyKey,
          now - SLACK_THREAD_CONTINUITY_WINDOW_MS
        );
        if (
          steerable?.session_id &&
          (await this.steerSession(steerable.session_id, automation, event))
        ) {
          steered++;
          continue;
        }
        // No steerable session (outside the window, no session yet, or a rare
        // enqueue error) → fall through. Like the @mention path's stale-session
        // recovery, the reply is re-evaluated as a potential new trigger below.
      }

      // Trigger conditions gate starting a NEW run.
      const config: TriggerConfig = automation.trigger_config
        ? JSON.parse(automation.trigger_config)
        : { conditions: [] };
      if (!matchesConditions(config.conditions, event, conditionRegistry)) {
        continue;
      }

      // Concurrency guard: never start a second run while one is active for this
      // key. For slack this also covers the brief window before a run has created
      // its session (no steerable row yet), so a reply racing the initial trigger
      // gets the "already active" notice instead of a second session.
      const activeRun = await store.getActiveRunForKey(automation.id, event.concurrencyKey);
      if (activeRun) {
        if (event.source === "slack") {
          await this.recordSlackSkip(store, automation.id, event, "concurrent_run_active");
          concurrencySkipped = true;
        }
        skipped++;
        continue;
      }

      // Create run (dedup via unique index on trigger_key)
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
          ...(event.source === "slack" ? slackRunMetadata(event) : {}),
        });
      } catch (e) {
        if (isDuplicateKeyError(e)) {
          skipped++;
          continue;
        }
        throw e;
      }

      // Create session + send prompt (with event context prepended)
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
        await this.failRunAndTrackBestEffort(store, runId, automation.id, message);
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
      steered,
      candidates: candidates.length,
    });

    return new Response(JSON.stringify({ triggered, skipped, steered }), {
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

      await this.failRunAndTrackBestEffort(store, runId, automationId, message);

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
      /** Optional for resilience to version skew; the bot falls back to a reaction clear. */
      messageId?: string;
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

    // Slack-triggered runs post the agent's result into the triggering message's
    // thread and clear the `eyes` reaction when they finish. The scheduler owns
    // this fan-out (not the session callback path) because the message
    // coordinates live on the run row. Best-effort.
    const slackMeta = getSlackRunMetadata(run);
    if (slackMeta) {
      const automation = await store.getById(body.automationId);
      await this.notifySlackCompletion(run, slackMeta, {
        sessionId: body.sessionId,
        messageId: body.messageId ?? "",
        success: body.success,
        error: body.error,
        repoFullName: automation ? `${automation.repo_owner}/${automation.repo_name}` : "",
        model: automation?.model ?? "",
        reasoningEffort: automation?.reasoning_effort ?? undefined,
      });
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  /**
   * Persist a `skipped` run for a slack event dropped by the per-thread
   * concurrency guard, carrying the same message coordinates a materialized run
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
      runMetadata: slackRunMetadata(event),
    });
  }

  /**
   * Tell the slack-bot to post a slack-triggered run's result into the triggering
   * message's thread and clear the `eyes` reaction, via its
   * `/callbacks/automation-complete` endpoint. Signs the body with
   * `INTERNAL_CALLBACK_SECRET` (in-body HMAC, matching the bot's other callbacks).
   * No-ops when the run has no triggering message, when `SLACK_BOT` is unbound, or
   * when the secret is unset — all best-effort.
   */
  private async notifySlackCompletion(
    run: AutomationRunRow,
    meta: SlackRunMetadata,
    ctx: SlackCompletionContext
  ): Promise<void> {
    const binding = this.env.SLACK_BOT;
    const secret = this.env.INTERNAL_CALLBACK_SECRET;
    if (!binding || !secret) return;

    const body = buildSlackCompletionNotification(meta, ctx);
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
      const response = await binding.fetch("https://internal/callbacks/automation-skip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, signature }),
      });
      if (!response.ok) {
        this.log.warn("Slack skip callback failed", {
          event: "scheduler.slack_skip_failed",
          channel: event.channelId,
          http_status: response.status,
        });
      }
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
    const callbackContext: AutomationCallbackContext = {
      source: "automation",
      automationId: automation.id,
      runId,
      automationName: automation.name,
    };

    await this.enqueueSessionPrompt(sessionId, {
      content: instructionsOverride ?? automation.instructions,
      authorId: automation.created_by,
      source: "automation",
      callbackContext,
    });
  }

  /**
   * Route a follow-up slack message in a thread to its run's existing session as
   * the next turn — whether that run is still in flight, completed, or failed —
   * so every reply in the thread continues the same session, like the interactive
   * @mention path. If the session has gone idle the prompt re-spawns/restores it
   * in the background; its reply posts back in-thread via the slack completion
   * callback (source "slack"), exactly like an interactive follow-up. Returns
   * false when the enqueue fails, so the caller can fall through to the trigger
   * path (stale-session recovery).
   */
  private async steerSession(
    sessionId: string,
    automation: AutomationRow,
    event: SlackAutomationEvent
  ): Promise<boolean> {
    const callbackContext: SlackCallbackContext = {
      source: "slack",
      channel: event.channelId,
      // Post in the existing thread; for a reply, threadTs is the thread root.
      threadTs: event.threadTs ?? event.ts,
      // React on (and later clear) the follow-up message itself.
      reactionMessageTs: event.ts,
      repoFullName: `${automation.repo_owner}/${automation.repo_name}`,
      model: automation.model,
      reasoningEffort: automation.reasoning_effort ?? undefined,
    };

    try {
      await this.enqueueSessionPrompt(sessionId, {
        content: event.text,
        authorId: `slack:${event.actorUserId}`,
        source: "slack",
        callbackContext,
      });
      this.log.info("Steered thread session with slack follow-up", {
        event: "scheduler.slack_steer",
        automation_id: automation.id,
        session_id: sessionId,
        channel: event.channelId,
      });
      return true;
    } catch (e) {
      this.log.warn("Failed to steer thread session; falling through to trigger path", {
        event: "scheduler.slack_steer_failed",
        automation_id: automation.id,
        session_id: sessionId,
        error: e instanceof Error ? e : new Error(String(e)),
      });
      return false;
    }
  }

  /** Enqueue a prompt onto a session's queue via its DO `/internal/prompt` route. */
  private async enqueueSessionPrompt(
    sessionId: string,
    body: {
      content: string;
      authorId: string;
      source: string;
      callbackContext: AutomationCallbackContext | SlackCallbackContext;
    }
  ): Promise<void> {
    const stub = this.env.SESSION.get(this.env.SESSION.idFromName(sessionId));
    const promptResponse = await stub.fetch("http://internal/internal/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!promptResponse.ok) {
      throw new Error(`Prompt enqueue failed with status ${promptResponse.status}`);
    }
  }
}

/** Serialized slack run metadata for a slack-origin event — shared by insertRun and recordSkippedRun. */
function slackRunMetadata(
  event: SlackAutomationEvent
): Pick<AutomationRunRow, "trigger_run_metadata"> {
  const metadata: SlackRunMetadata = {
    channel: event.channelId,
    messageTs: event.ts,
  };
  return { trigger_run_metadata: JSON.stringify(metadata) };
}
