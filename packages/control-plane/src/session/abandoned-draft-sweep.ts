/**
 * Retirement of warm sessions that were never prompted.
 *
 * The web client warms a session on the first keystroke, so navigating away
 * without submitting leaves a `created` row behind. Nothing else advances it:
 * `active` requires an enqueued prompt, and the terminal statuses require a
 * finished execution. The sandbox idles out on its own, but that path writes
 * only sandbox state, so the session would sit in an intermediate dead state
 * indefinitely.
 */

import { z } from "zod";
import { buildSessionInternalUrl, SessionInternalPaths } from "./contracts";
import type { Logger } from "../logger";

/**
 * How long a warm session may sit unprompted before the sweep archives it.
 *
 * Measured in hours, not the sandbox's minutes: the composer holds no socket to
 * the warm session, so the sandbox's inactivity timeout can fire while an author
 * is still typing. A stopped sandbox respawns on the next prompt, where an
 * archived session would reject it, so this clock has to outlast a long pause at
 * the keyboard. It does not outlast a draft left open overnight — an author
 * returning to one that far stale gets a rejected prompt.
 */
export const ABANDONED_DRAFT_TTL_MS = 8 * 60 * 60 * 1000;

/**
 * Max drafts to expire per sweep (backpressure); a backlog drains over ticks.
 * Each one costs a single subrequest to its Durable Object, so a full batch sits
 * well inside the caller's per-invocation budget. Steady state is a handful per
 * day — the cap only matters for an initial backlog.
 */
export const ABANDONED_DRAFT_SWEEP_LIMIT = 50;

/**
 * Bound on a single expiry request. The sweep awaits the whole batch, so one
 * stalled session would otherwise hold up everything the caller does next. An
 * abort arrives through the same rejection path as any other failure and is
 * counted as errored, leaving the session for a later sweep.
 */
export const ABANDONED_DRAFT_EXPIRY_TIMEOUT_MS = 10_000;

/**
 * The full outcome set of `/internal/expire-draft`. Validated at the boundary so
 * protocol drift surfaces as an error rather than being miscounted as routine
 * maintenance.
 */
export const draftExpiryOutcomeSchema = z.enum(["archived", "not_draft", "has_work"]);
export type DraftExpiryOutcome = z.infer<typeof draftExpiryOutcomeSchema>;

/**
 * What the sweep saw for one candidate. `missing` is not one of the protocol
 * outcomes above: the Durable Object answered 404, so no session exists behind
 * the index row at all.
 */
export type DraftSweepOutcome = DraftExpiryOutcome | "missing";

const draftExpiryResponseSchema = z.object({ outcome: draftExpiryOutcomeSchema });

/** The index access the sweep needs; `SessionIndexStore` satisfies it. */
export interface AbandonedDraftIndex {
  listAbandonedDraftSessionIds(staleBefore: number, limit: number): Promise<string[]>;
  archiveOrphanedDraft(id: string): Promise<boolean>;
}

/** Asks one session to retire itself. */
export interface DraftExpiryClient {
  expireDraft(sessionId: string): Promise<DraftSweepOutcome>;
}

/**
 * Own cron rather than the automation tick. Retention is measured in hours, so
 * riding a per-minute tick meant ~1,440 queries a day to action a handful of
 * rows — and shared that tick's subrequest budget with automation launches.
 * Offset from IMAGE_BUILD_SCHEDULER_CRON so the two never fire together.
 */
export const ABANDONED_DRAFT_SWEEP_CRON = "23 * * * *";

export interface AbandonedDraftSweepResult {
  candidates: number;
  archived: number;
  /** Session had already left `created`; the index was stale and was repaired. */
  notDraft: number;
  /** Session still `created` but holds messages — a prompt that never dispatched. */
  hasWork: number;
  /** Index row with no Durable Object session behind it; retired in the index. */
  missing: number;
  errored: number;
  /** The query is capped, so a full batch means more remain for the next sweep. */
  truncated: boolean;
}

/** Calls a session Durable Object's expiry route and validates its reply. */
export class SessionDraftExpiryClient implements DraftExpiryClient {
  constructor(private readonly sessions: DurableObjectNamespace) {}

  async expireDraft(sessionId: string): Promise<DraftSweepOutcome> {
    const stub = this.sessions.get(this.sessions.idFromName(sessionId));
    const response = await stub.fetch(buildSessionInternalUrl(SessionInternalPaths.expireDraft), {
      method: "POST",
      signal: AbortSignal.timeout(ABANDONED_DRAFT_EXPIRY_TIMEOUT_MS),
    });

    // Reported rather than thrown: a 404 is a definitive answer about this row,
    // so the sweep can retire it, where an error would have it retried forever.
    if (response.status === 404) {
      return "missing";
    }

    if (!response.ok) {
      throw new Error(`Draft expiry failed with status ${response.status}`);
    }

    const parsed = draftExpiryResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new Error("Draft expiry returned an unrecognized outcome");
    }

    return parsed.data.outcome;
  }
}

export class AbandonedDraftSweep {
  constructor(
    private readonly index: AbandonedDraftIndex,
    private readonly client: DraftExpiryClient,
    private readonly log: Logger,
    private readonly ttlMs: number = ABANDONED_DRAFT_TTL_MS,
    private readonly limit: number = ABANDONED_DRAFT_SWEEP_LIMIT
  ) {}

  /**
   * Candidates come from the index, which may have been read before a prompt
   * arrived, so each session re-checks the invariant inside its own Durable
   * Object before transitioning.
   *
   * The batch is read oldest-first, which only drains while every visited row
   * leaves the candidate set. Each outcome is therefore a state change: expired
   * and repaired sessions leave `created` in the Durable Object, and a session
   * that turns out not to exist is retired in the index here.
   */
  async run(now: number): Promise<AbandonedDraftSweepResult> {
    const empty: AbandonedDraftSweepResult = {
      candidates: 0,
      archived: 0,
      notDraft: 0,
      hasWork: 0,
      missing: 0,
      errored: 0,
      truncated: false,
    };

    let candidates: string[];
    try {
      candidates = await this.index.listAbandonedDraftSessionIds(now - this.ttlMs, this.limit);
    } catch (error) {
      this.log.error("Abandoned draft sweep failed to query candidates", {
        event: "scheduler.abandoned_draft_sweep_query_failed",
        error: error instanceof Error ? error.message : String(error),
      });
      return empty;
    }

    if (candidates.length === 0) return empty;

    const outcomes = await Promise.allSettled(
      candidates.map((sessionId) => this.expireOne(sessionId))
    );

    const result: AbandonedDraftSweepResult = {
      candidates: candidates.length,
      archived: 0,
      notDraft: 0,
      hasWork: 0,
      missing: 0,
      errored: 0,
      truncated: candidates.length === this.limit,
    };

    for (const [index, outcome] of outcomes.entries()) {
      if (outcome.status === "rejected") {
        result.errored += 1;
        this.log.warn("Abandoned draft expiry failed", {
          event: "scheduler.abandoned_draft_expiry_failed",
          session_id: candidates[index],
          error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
        });
      } else if (outcome.value === "archived") {
        result.archived += 1;
      } else if (outcome.value === "not_draft") {
        result.notDraft += 1;
      } else if (outcome.value === "has_work") {
        result.hasWork += 1;
      } else {
        result.missing += 1;
      }
    }

    // Serialized field by field rather than spread: log fields are snake_case
    // here, and several share their names with the protocol outcomes.
    this.log.info("Abandoned draft sweep completed", {
      event: "scheduler.abandoned_draft_sweep",
      candidates: result.candidates,
      archived: result.archived,
      not_draft: result.notDraft,
      has_work: result.hasWork,
      missing: result.missing,
      errored: result.errored,
      truncated: result.truncated,
    });

    // Only a failure leaves a row in place, so a full batch where nothing else
    // happened means the next run reads exactly these rows again. Raised loudly
    // because the symptom is otherwise indistinguishable from routine work: the
    // sweep spun on the same 50 rows for a day logging `truncated` at info.
    if (result.truncated && result.candidates === result.errored) {
      this.log.error("Abandoned draft sweep made no progress", {
        event: "scheduler.abandoned_draft_sweep_stalled",
        candidates: result.candidates,
        errored: result.errored,
      });
    }

    return result;
  }

  /**
   * A missing session is retired here rather than by its Durable Object: there
   * is no Durable Object to do it, which is exactly what the 404 established.
   */
  private async expireOne(sessionId: string): Promise<DraftSweepOutcome> {
    const outcome = await this.client.expireDraft(sessionId);
    if (outcome === "missing") {
      await this.index.archiveOrphanedDraft(sessionId);
    }
    return outcome;
  }
}
