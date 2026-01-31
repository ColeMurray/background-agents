/**
 * Task extraction utilities for parsing TodoWrite events
 */

import type { Task } from "@/types/session";

interface SandboxEvent {
  type: string;
  tool?: string;
  args?: Record<string, unknown>;
  timestamp: number;
  /** Event row id (for Linear task linking) */
  id?: string;
  /** Message id (for Linear task linking) */
  messageId?: string;
}

interface TodoWriteArgs {
  todos?: Array<{
    content: string;
    status: "pending" | "in_progress" | "completed";
    activeForm?: string;
  }>;
}

/** OpenCode sends todo_write (snake_case); accept that and TodoWrite in any casing */
function isTodoWriteEvent(event: SandboxEvent): boolean {
  const tool = (event.tool ?? "").toLowerCase();
  return event.type === "tool_call" && (tool === "todowrite" || tool === "todo_write");
}

/**
 * Extract the latest task list from sandbox events
 * Finds the most recent TodoWrite tool_call and parses its todos
 */
export function extractLatestTasks(events: SandboxEvent[]): Task[] {
  const todoWriteEvents = events
    .filter(isTodoWriteEvent)
    .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));

  if (todoWriteEvents.length === 0) {
    return [];
  }

  const latestTodoWrite = todoWriteEvents[0];
  const args = latestTodoWrite.args as TodoWriteArgs | undefined;

  if (!args?.todos || !Array.isArray(args.todos)) {
    return [];
  }

  const eventId = (latestTodoWrite as SandboxEvent & { id?: string }).id;
  const messageId = (latestTodoWrite as SandboxEvent & { messageId?: string }).messageId;

  return args.todos.map((todo, taskIndex) => ({
    content: todo.content || "",
    status: todo.status || "pending",
    activeForm: todo.activeForm,
    messageId,
    eventId,
    taskIndex,
  }));
}

/**
 * Get task counts by status
 */
export function getTaskCounts(tasks: Task[]): {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
} {
  return {
    total: tasks.length,
    pending: tasks.filter((t) => t.status === "pending").length,
    inProgress: tasks.filter((t) => t.status === "in_progress").length,
    completed: tasks.filter((t) => t.status === "completed").length,
  };
}

/**
 * Get the currently active task (in_progress status)
 */
export function getCurrentTask(tasks: Task[]): Task | null {
  return tasks.find((t) => t.status === "in_progress") || null;
}
