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
  type AutomationCallbackContext,
  type AutomationEvent,
  type TriggerConfig,
} from "@open-inspect/shared";
import { AutomationStore, toAutomationRun, type AutomationRow } from "../db/automation-store";
import { SessionIndexStore } from "../db/session-index";
import { generateId } from "../auth/crypto";
import { createLogger, parseLogLevel } from "../logger";
import type { Logger } from "../logger";
import type { Env } from "../types";

/** Max automations to process per tick (backpressure). */
const MAX_PER_TICK = 25;

/** Threshold for detecting orphaned "starting" runs (5 minutes). */
const ORPHAN_THRESHOLD_MS = 5 * 60 * 1000;

/** Default execution timeout for detecting timed-out runs (90 minutes). */
const DEFAULT_EXECUTION_TIMEOUT_MS = 90 * 60 * 1000;

/** Consecutive failure threshold for auto-pause. */
const AUTO_PAUSE_THRESHOLD = 3;

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
      case "sentry":
        candidates = await store.getAutomationsForSentryEvent(event.eventType);
        break;
      case "github":
      case "linear":
        candidates = await store.getAutomationsForEvent(
          event.repoOwner,
          event.repoName,
          event.source === "github" ? "github_event" : "linear_event",
          event.eventType
        );
        break;
    }

    let triggered = 0;
    let skipped = 0;

    for (const automation of candidates) {
      // 2. Evaluate conditions
      const config: TriggerConfig = automation.trigger_config
        ? JSON.parse(automation.trigger_config)
        : { conditions: [] };
      if (!matchesConditions(config.conditions, event, conditionRegistry)) {
        continue;
      }

      // 3. Concurrency check (per-event-instance)
      const activeRun = await store.getActiveRunForKey(automation.id, event.concurrencyKey);
      if (activeRun) {
        skipped++;
        continue;
      }

      // 4. Create run (dedup via unique index on trigger_key)
      const runId = generateId();
      const now = Date.now();
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

    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    });
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
    const doId = this.env.SESSION.idFromName(sessionId);
    const stub = this.env.SESSION.get(doId);

    // Initialize the session DO
    const initResponse = await stub.fetch("http://internal/internal/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionName: sessionId,
        repoOwner: automation.repo_owner,
        repoName: automation.repo_name,
        repoId: automation.repo_id,
        defaultBranch: automation.base_branch,
        model: automation.model,
        reasoningEffort: automation.reasoning_effort,
        title: `[Auto] ${automation.name}`,
        userId: automation.created_by,
        spawnSource: "automation",
      }),
    });

    if (!initResponse.ok) {
      throw new Error(`Session init failed with status ${initResponse.status}`);
    }

    // Index the session in D1
    const now = Date.now();
    const sessionStore = new SessionIndexStore(this.env.DB);
    await sessionStore.create({
      id: sessionId,
      title: `[Auto] ${automation.name}`,
      repoOwner: automation.repo_owner,
      repoName: automation.repo_name,
      model: automation.model,
      reasoningEffort: automation.reasoning_effort,
      baseBranch: automation.base_branch,
      status: "created",
      spawnSource: "automation",
      spawnDepth: 0,
      automationId: automation.id,
      automationRunId: runId,
      createdAt: now,
      updatedAt: now,
    });

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

function isDuplicateKeyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("UNIQUE constraint failed");
}
