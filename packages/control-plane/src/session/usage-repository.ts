import { harnessIdSchema } from "@open-inspect/shared/harnesses";
import { normalizeTokenUsage, type StepUsage } from "@open-inspect/shared";
import type { SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import { z } from "zod";
import type { SqlStorage, TransactionSync } from "./sql-storage";
import { SessionStorageIntegrityError } from "./types";

const MAX_STEP_USAGE_PAGE_SIZE = 100;

const stepUsageRowSchema = z.object({
  id: z.string(),
  message_id: z.string().nullable(),
  model: z.string().nullable(),
  harness: harnessIdSchema.nullable(),
  input_tokens: z.number().nullable(),
  output_tokens: z.number().nullable(),
  reasoning_tokens: z.number().nullable(),
  cache_read_tokens: z.number().nullable(),
  cache_write_tokens: z.number().nullable(),
  total_tokens: z.number().nullable(),
  step_cost_usd: z.number().nullable(),
  message_cost_usd: z.number().nullable(),
  is_subtask: z.union([z.literal(0), z.literal(1)]),
  child_session_id: z.string().nullable(),
  task_call_id: z.string().nullable(),
  reason: z.string().nullable(),
  created_at: z.number(),
});

const totalsRowSchema = z.object({
  row_count: z.number(),
  input_tokens: z.number().nullable(),
  output_tokens: z.number().nullable(),
  reasoning_tokens: z.number().nullable(),
  cache_read_tokens: z.number().nullable(),
  cache_write_tokens: z.number().nullable(),
  total_tokens: z.number().nullable(),
});

const modelRowSchema = z.object({
  model: z.string().nullable(),
  harness: harnessIdSchema.nullable(),
});

export type SessionUsageTotals = {
  rowCount: number;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  totalTokens: number | null;
};

export interface StepUsageCursor {
  createdAt: number;
  id: string;
}

export class UsageRepository {
  constructor(
    private readonly sql: SqlStorage,
    private readonly transactionSync: TransactionSync
  ) {}

  recordStepUsage(
    event: Extract<SandboxEvent, { type: "step_finish" }>,
    messageId: string | null,
    createdAt: number
  ): void {
    const attributedMessageId = messageId ?? event.messageId;
    const tokens = normalizeTokenUsage(event.tokens);
    this.transactionSync(() => {
      const source = modelRowSchema.safeParse(
        this.sql
          .exec(
            `SELECT COALESCE((SELECT model FROM messages WHERE id = ?), (SELECT model FROM session LIMIT 1)) AS model,
                  (SELECT harness FROM session LIMIT 1) AS harness`,
            attributedMessageId
          )
          .one()
      );
      if (!source.success)
        throw new SessionStorageIntegrityError("Malformed usage attribution row");
      // A timestamp fallback cannot distinguish a correction from another step.
      this.sql.exec(
        `INSERT INTO step_usage (
          id, message_id, model, harness, input_tokens, output_tokens, reasoning_tokens,
          cache_read_tokens, cache_write_tokens, total_tokens, step_cost_usd, message_cost_usd,
          is_subtask, child_session_id, task_call_id, reason, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          input_tokens = excluded.input_tokens,
          output_tokens = excluded.output_tokens,
          reasoning_tokens = excluded.reasoning_tokens,
          cache_read_tokens = excluded.cache_read_tokens,
          cache_write_tokens = excluded.cache_write_tokens,
          total_tokens = excluded.total_tokens,
          step_cost_usd = excluded.step_cost_usd,
          message_cost_usd = excluded.message_cost_usd,
          is_subtask = excluded.is_subtask,
          child_session_id = excluded.child_session_id,
          task_call_id = excluded.task_call_id,
          reason = excluded.reason
        WHERE ? IS NOT NULL`,
        event.stepId ?? `${attributedMessageId}:${event.timestamp}`,
        attributedMessageId,
        source.data.model,
        source.data.harness,
        tokens.inputTokens,
        tokens.outputTokens,
        tokens.reasoningTokens,
        tokens.cacheReadTokens,
        tokens.cacheWriteTokens,
        tokens.totalTokens,
        event.cost != null && Number.isFinite(event.cost) && event.cost >= 0 ? event.cost : null,
        event.messageCostUsd != null && Number.isFinite(event.messageCostUsd)
          ? event.messageCostUsd
          : null,
        event.isSubtask ? 1 : 0,
        event.childSessionId ?? null,
        event.taskCallId ?? null,
        event.reason ?? null,
        createdAt,
        event.stepId ?? null
      );
    });
  }

  getSessionTotals(): SessionUsageTotals {
    const parsed = totalsRowSchema.safeParse(
      this.sql
        .exec(
          `SELECT COUNT(*) AS row_count,
        SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
        SUM(reasoning_tokens) AS reasoning_tokens, SUM(cache_read_tokens) AS cache_read_tokens,
        SUM(cache_write_tokens) AS cache_write_tokens, SUM(total_tokens) AS total_tokens
        FROM step_usage`
        )
        .one()
    );
    if (!parsed.success) throw new SessionStorageIntegrityError("Malformed step usage totals row");
    const row = parsed.data;
    return {
      rowCount: row.row_count,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      reasoningTokens: row.reasoning_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cacheWriteTokens: row.cache_write_tokens,
      totalTokens: row.total_tokens,
    };
  }

  listStepUsage(
    cursor: StepUsageCursor | null,
    limit: number
  ): {
    items: StepUsage[];
    nextCursor: StepUsageCursor | null;
  } {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_STEP_USAGE_PAGE_SIZE) {
      throw new RangeError("Invalid step usage limit");
    }
    if (
      cursor &&
      (!Number.isSafeInteger(cursor.createdAt) ||
        cursor.createdAt < 0 ||
        typeof cursor.id !== "string" ||
        cursor.id.length === 0)
    ) {
      throw new TypeError("Invalid step usage cursor");
    }
    const rows = (
      cursor
        ? this.sql.exec(
            `SELECT * FROM step_usage WHERE created_at > ? OR (created_at = ? AND id > ?)
           ORDER BY created_at, id LIMIT ?`,
            cursor.createdAt,
            cursor.createdAt,
            cursor.id,
            limit + 1
          )
        : this.sql.exec(`SELECT * FROM step_usage ORDER BY created_at, id LIMIT ?`, limit + 1)
    ).toArray();
    const items = rows.slice(0, limit).map((raw): StepUsage => {
      const parsed = stepUsageRowSchema.safeParse(raw);
      if (!parsed.success)
        throw new SessionStorageIntegrityError("Malformed persisted step usage row");
      const row = parsed.data;
      return {
        id: row.id,
        messageId: row.message_id,
        model: row.model,
        harness: row.harness,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        reasoningTokens: row.reasoning_tokens,
        cacheReadTokens: row.cache_read_tokens,
        cacheWriteTokens: row.cache_write_tokens,
        totalTokens: row.total_tokens,
        stepCostUsd: row.step_cost_usd,
        messageCostUsd: row.message_cost_usd,
        isSubtask: row.is_subtask === 1,
        childSessionId: row.child_session_id,
        taskCallId: row.task_call_id,
        reason: row.reason,
        createdAt: row.created_at,
      };
    });
    const last = items.at(-1);
    return {
      items,
      nextCursor: rows.length > limit && last ? { createdAt: last.createdAt, id: last.id } : null,
    };
  }
}
