import {
  DEFAULT_HARNESS,
  getValidHarnessOrDefault,
  harnessIdSchema,
} from "@open-inspect/shared/harnesses";
import { sessionStatusSchema, spawnSourceSchema } from "@open-inspect/shared/types/sessions";
import { z } from "zod";

/** Persisted D1 session row shared by index and export readers. */
export const sessionRowSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  repo_owner: z.string().nullable(),
  repo_name: z.string().nullable(),
  harness: harnessIdSchema.catch(DEFAULT_HARNESS),
  model: z.string(),
  reasoning_effort: z.string().nullable(),
  base_branch: z.string().nullable(),
  status: sessionStatusSchema,
  parent_session_id: z.string().nullable(),
  root_session_id: z.string().nullable(),
  spawn_source: spawnSourceSchema,
  spawn_depth: z.number(),
  automation_id: z.string().nullable(),
  automation_run_id: z.string().nullable(),
  scm_login: z.string().nullable(),
  user_id: z.string().nullable(),
  total_cost: z.number(),
  active_duration_ms: z.number(),
  message_count: z.number(),
  pr_count: z.number(),
  input_tokens: z.number(),
  output_tokens: z.number(),
  reasoning_tokens: z.number(),
  cache_read_tokens: z.number(),
  cache_write_tokens: z.number(),
  environment_id: z.string().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
});

export type SessionRow = z.infer<typeof sessionRowSchema>;

export function parseSessionRow(row: unknown): SessionRow | null {
  if (row === null || row === undefined) return null;
  const parsed = sessionRowSchema.safeParse(row);
  if (!parsed.success) throw new Error("Malformed persisted session index row");
  return parsed.data;
}

export function toSessionFields(row: SessionRow) {
  return {
    id: row.id,
    title: row.title,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    harness: getValidHarnessOrDefault(row.harness),
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    baseBranch: row.base_branch,
    status: row.status,
    parentSessionId: row.parent_session_id,
    spawnSource: row.spawn_source,
    spawnDepth: row.spawn_depth,
    automationId: row.automation_id,
    automationRunId: row.automation_run_id,
    scmLogin: row.scm_login,
    userId: row.user_id,
    totalCost: row.total_cost,
    activeDurationMs: row.active_duration_ms,
    messageCount: row.message_count,
    prCount: row.pr_count,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    reasoningTokens: row.reasoning_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    environmentId: row.environment_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
