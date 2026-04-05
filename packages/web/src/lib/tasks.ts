/**
 * Task extraction utilities for parsing TodoWrite and Agent/Task tool events
 */

import type { SandboxEvent, Task } from "@/types/session";

type ToolCallEvent = Extract<SandboxEvent, { type: "tool_call" }>;

interface TodoWriteArgs {
  todos?: Array<{
    content: string;
    status: "pending" | "in_progress" | "completed";
    activeForm?: string;
  }>;
}

/**
 * Map a tool_call status to a Task status.
 * tool_call events use "running" / "completed" / "failed" etc.
 */
function mapToolCallStatus(status: string | undefined): Task["status"] {
  if (status === "completed") return "completed";
  if (status === "running") return "in_progress";
  return "pending";
}

/**
 * Extract tasks from TodoWrite events (checklist-style)
 */
function extractTodoWriteTasks(events: ToolCallEvent[]): Task[] {
  const todoWriteEvents = events
    .filter((event): event is ToolCallEvent => event.tool?.toLowerCase() === "todowrite")
    .sort((a, b) => b.timestamp - a.timestamp);

  if (todoWriteEvents.length === 0) return [];

  const latestTodoWrite = todoWriteEvents[0];
  const args = latestTodoWrite.args as TodoWriteArgs | undefined;

  if (!args?.todos || !Array.isArray(args.todos)) return [];

  return args.todos.map((todo) => ({
    content: todo.content || "",
    status: todo.status || "pending",
    activeForm: todo.activeForm,
  }));
}

/**
 * Extract tasks from Agent/Task tool calls (subagent dispatches).
 * Each unique callId is one task. If both a "running" and "completed" event
 * exist for the same callId, the latest status wins.
 */
function extractAgentTasks(events: ToolCallEvent[]): Task[] {
  const taskEvents = events.filter(
    (event): event is ToolCallEvent => event.tool?.toLowerCase() === "task"
  );

  if (taskEvents.length === 0) return [];

  // Group by callId, keep the latest event per callId for status
  const byCallId = new Map<string, ToolCallEvent>();
  for (const event of taskEvents) {
    const existing = byCallId.get(event.callId);
    if (!existing || event.timestamp > existing.timestamp) {
      byCallId.set(event.callId, event);
    }
  }

  // Sort by first appearance (use the earliest timestamp per callId)
  const firstSeen = new Map<string, number>();
  for (const event of taskEvents) {
    const seen = firstSeen.get(event.callId);
    if (seen === undefined || event.timestamp < seen) {
      firstSeen.set(event.callId, event.timestamp);
    }
  }

  return Array.from(byCallId.entries())
    .sort((a, b) => (firstSeen.get(a[0]) ?? 0) - (firstSeen.get(b[0]) ?? 0))
    .map(([, event]) => {
      const description =
        typeof event.args?.description === "string" ? event.args.description : undefined;
      const prompt = typeof event.args?.prompt === "string" ? event.args.prompt : undefined;
      return {
        content: description || prompt || "Task",
        status: mapToolCallStatus(event.status),
      };
    });
}

/**
 * Extract the latest task list from sandbox events.
 * Merges TodoWrite checklist items with Agent/Task subagent dispatches.
 */
export function extractLatestTasks(events: SandboxEvent[]): Task[] {
  const toolCallEvents = events.filter(
    (event): event is ToolCallEvent => event.type === "tool_call"
  );

  const todoTasks = extractTodoWriteTasks(toolCallEvents);
  const agentTasks = extractAgentTasks(toolCallEvents);

  // TodoWrite tasks first (explicit checklist), then agent tasks
  return [...todoTasks, ...agentTasks];
}
