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

const draftExpiryResponseSchema = z.object({ outcome: draftExpiryOutcomeSchema });

/** The index read the sweep needs; `SessionIndexStore` satisfies it. */
export interface AbandonedDraftIndex {
  listAbandonedDraftSessionIds(staleBefore: number, limit: number): Promise<string[]>;
}

/** Asks one session to retire itself. */
export interface DraftExpiryClient {
  expireDraft(sessionId: string): Promise<DraftExpiryOutcome>;
}

export interface AbandonedDraftSweepResult {
  candidates: number;
  archived: number;
  retained: number;
  errored: number;
  /** The query is capped, so a full batch means more remain for the next sweep. */
  truncated: boolean;
}

/** Calls a session Durable Object's expiry route and validates its reply. */
export class SessionDraftExpiryClient implements DraftExpiryClient {
  constructor(private readonly sessions: DurableObjectNamespace) {}

  async expireDraft(sessionId: string): Promise<DraftExpiryOutcome> {
    const stub = this.sessions.get(this.sessions.idFromName(sessionId));
    const response = await stub.fetch(buildSessionInternalUrl(SessionInternalPaths.expireDraft), {
      method: "POST",
      signal: AbortSignal.timeout(ABANDONED_DRAFT_EXPIRY_TIMEOUT_MS),
    });

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
   */
  async run(now: number): Promise<AbandonedDraftSweepResult> {
    const empty: AbandonedDraftSweepResult = {
      candidates: 0,
      archived: 0,
      retained: 0,
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
      candidates.map((sessionId) => this.client.expireDraft(sessionId))
    );

    const result: AbandonedDraftSweepResult = {
      candidates: candidates.length,
      archived: 0,
      retained: 0,
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
      } else {
        result.retained += 1;
      }
    }

    this.log.info("Abandoned draft sweep completed", {
      event: "scheduler.abandoned_draft_sweep",
      ...result,
    });

    return result;
  }
}
