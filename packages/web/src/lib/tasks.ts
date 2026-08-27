/**
 * Task extraction utilities for parsing TodoWrite events
 */

import type { SandboxEvent, Task } from "@/types/session";
import { z } from "zod";

type ToolCallEvent = Extract<SandboxEvent, { type: "tool_call" }>;

const todoWriteArgsSchema = z.object({
  todos: z
    .array(
      z.object({
        content: z.string().optional(),
        status: z.string().optional(),
        activeForm: z.string().optional(),
      })
    )
    .optional(),
});

function normalizeTaskStatus(status: string | undefined): Task["status"] {
  return status === "in_progress" || status === "completed" ? status : "pending";
}

/**
 * Extract the latest task list from sandbox events
 * Finds the most recent TodoWrite tool_call and parses its todos
 */
export function extractLatestTasks(events: SandboxEvent[]): Task[] {
  // Find all TodoWrite events, get the latest one
  // Use case-insensitive comparison — OpenCode may report tool names in lowercase
  const todoWriteEvents = events
    .filter(
      (event): event is ToolCallEvent =>
        event.type === "tool_call" && event.tool?.toLowerCase() === "todowrite"
    )
    .sort((a, b) => b.timestamp - a.timestamp);

  if (todoWriteEvents.length === 0) {
    return [];
  }

  const latestTodoWrite = todoWriteEvents[0];
  const parsedArgs = todoWriteArgsSchema.safeParse(latestTodoWrite.args);

  if (!parsedArgs.success || !parsedArgs.data.todos) {
    return [];
  }

  return parsedArgs.data.todos.map((todo) => ({
    content: todo.content || "",
    status: normalizeTaskStatus(todo.status),
    activeForm: todo.activeForm,
  }));
}
