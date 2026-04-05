/**
 * Skill timeline extraction from sandbox events.
 *
 * Scans tool_call events for Skill invocations and builds a timeline
 * of skill phases: which skills were used and their status.
 */

import type { SandboxEvent } from "@/types/session";

type ToolCallEvent = Extract<SandboxEvent, { type: "tool_call" }>;

export interface SkillPhase {
  name: string;
  status: "active" | "completed";
  startedAt: number;
  description?: string;
}

/**
 * Extract a skill timeline from sandbox events.
 *
 * A Skill tool call marks the start of a new skill phase.
 * All phases except the last are "completed". The last phase is "active"
 * unless an execution_complete event follows it — then all are "completed".
 */
export function extractSkillTimeline(events: SandboxEvent[]): SkillPhase[] {
  const phases: SkillPhase[] = [];
  let hasExecutionComplete = false;

  for (const event of events) {
    if (event.type === "execution_complete") {
      hasExecutionComplete = true;
      continue;
    }

    if (event.type !== "tool_call") continue;

    const toolEvent = event as ToolCallEvent;
    if (toolEvent.tool?.toLowerCase() !== "skill") continue;

    // OpenCode's Skill tool uses "name" as the input field.
    const skillName =
      typeof toolEvent.args?.name === "string"
        ? toolEvent.args.name
        : typeof toolEvent.args?.skill === "string"
          ? toolEvent.args.skill
          : null;
    if (!skillName) continue;

    const description = typeof toolEvent.args?.args === "string" ? toolEvent.args.args : undefined;

    phases.push({
      name: skillName,
      status: "active",
      startedAt: toolEvent.timestamp,
      ...(description ? { description } : {}),
    });
  }

  // Mark all but the last as completed. If execution_complete seen, mark all completed.
  for (let i = 0; i < phases.length; i++) {
    if (i < phases.length - 1 || hasExecutionComplete) {
      phases[i].status = "completed";
    }
  }

  return phases;
}
