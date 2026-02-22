/**
 * Task extraction utilities for parsing TodoWrite events
 */

import type { Task } from "@/types/session";

interface SandboxEvent {
  type: string;
  tool?: string;
  args?: Record<string, unknown>;
  timestamp: number;
}

interface TodoWriteArgs {
  todos?: Array<{
    content: string;
    status: "pending" | "in_progress" | "completed";
    activeForm?: string;
  }>;
}

/**
 * Extract the latest task list from sandbox events
 * Finds the most recent TodoWrite tool_call and parses its todos
 */
export function extractLatestTasks(events: SandboxEvent[]): Task[] {
  // Find all TodoWrite events, get the latest one
  const todoWriteEvents = events
    .filter((event) => event.type === "tool_call" && event.tool === "TodoWrite")
    .sort((a, b) => b.timestamp - a.timestamp);

  if (todoWriteEvents.length === 0) {
    return [];
  }

  const latestTodoWrite = todoWriteEvents[0];
  const args = latestTodoWrite.args as TodoWriteArgs | undefined;

  if (!args?.todos || !Array.isArray(args.todos)) {
    return [];
  }

  return args.todos.map((todo) => ({
    content: todo.content || "",
    status: todo.status || "pending",
    activeForm: todo.activeForm,
  }));
}
