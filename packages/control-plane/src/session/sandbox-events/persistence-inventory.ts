import type { SandboxEvent } from "@open-inspect/shared/types/sandbox-events";

/**
 * How a sandbox event reaches the session's `events` table, which is both
 * the timeline and the trace a session export reads.
 *
 * - `append`: one row per accepted event under a fresh id. Keeps every event.
 *   (`boot_progress` is accepted once per `bootSeq`; a resend is dropped.)
 * - `upsert_by_message`: one row per message, id `<type>:<messageId>`. Keeps
 *   one event per message. For `token` that is the latest cumulative text;
 *   `context_compacted` renames the row first, so the text before each
 *   compaction survives as its own row. `execution_complete` is written only
 *   while its message is processing, so the first completion stays and a
 *   resend is dropped.
 * - `upsert_by_tool_call`: one row per tool-call identity (message, subtask
 *   scope, call id). Keeps the latest state at the first state's timeline
 *   position; earlier states (running, partial output) are overwritten.
 * - `usage_table`: no `events` row. Normalized token usage goes to
 *   `step_usage`; everything else on the event is dropped.
 * - `none`: no row anywhere in the timeline. Broadcast or side effect only.
 */
export type SandboxEventPersistence =
  | "append"
  | "upsert_by_message"
  | "upsert_by_tool_call"
  | "usage_table"
  | "none";

/**
 * The persistence mode of every sandbox event type, as dispatched by
 * `SessionSandboxEventProcessor`. Keyed by the full union, so a new event
 * type does not compile until someone decides how it persists.
 */
export const SANDBOX_EVENT_PERSISTENCE: Record<SandboxEvent["type"], SandboxEventPersistence> = {
  token: "upsert_by_message",
  context_compacted: "append",
  tool_call: "upsert_by_tool_call",
  tool_result: "append",
  error: "append",
  warning: "append",
  user_message: "append",
  push_complete: "append",
  push_error: "append",
  ready: "append",
  boot_progress: "append",
  git_sync: "append",
  artifact: "append",
  execution_complete: "upsert_by_message",
  step_start: "none",
  step_finish: "usage_table",
  heartbeat: "none",
  session_title: "none",
  snapshot_ready: "none",
  sandbox_generation_ready: "none",
  preservation_prepared: "none",
};
