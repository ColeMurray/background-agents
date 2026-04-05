import { describe, it, expect } from "vitest";
import { extractSkillTimeline } from "./skills";
import type { SandboxEvent } from "@/types/session";

type ToolCallEvent = Extract<SandboxEvent, { type: "tool_call" }>;

function makeSkillCall(overrides: Partial<ToolCallEvent> = {}): ToolCallEvent {
  return {
    type: "tool_call",
    tool: "Skill",
    args: { skill: "brainstorming" },
    callId: "call-1",
    messageId: "msg-1",
    sandboxId: "sandbox-1",
    timestamp: 1000,
    ...overrides,
  };
}

function makeExecComplete(timestamp: number): SandboxEvent {
  return {
    type: "execution_complete",
    messageId: "msg-1",
    success: true,
    sandboxId: "sandbox-1",
    timestamp,
  };
}

describe("extractSkillTimeline", () => {
  it("returns empty array for no events", () => {
    expect(extractSkillTimeline([])).toEqual([]);
  });

  it("returns empty array when no Skill tool calls", () => {
    const events: SandboxEvent[] = [
      {
        type: "tool_call",
        tool: "Read",
        args: { filePath: "foo.ts" },
        callId: "c1",
        messageId: "msg-1",
        sandboxId: "sb-1",
        timestamp: 1000,
      },
    ];
    expect(extractSkillTimeline(events)).toEqual([]);
  });

  it("marks single skill as active when no execution_complete", () => {
    const events: SandboxEvent[] = [
      makeSkillCall({ timestamp: 1000, args: { skill: "brainstorming" } }),
    ];
    const result = extractSkillTimeline(events);
    expect(result).toEqual([{ name: "brainstorming", status: "active", startedAt: 1000 }]);
  });

  it("marks all skills completed after execution_complete", () => {
    const events: SandboxEvent[] = [
      makeSkillCall({ timestamp: 1000, callId: "c1", args: { skill: "brainstorming" } }),
      makeSkillCall({ timestamp: 2000, callId: "c2", args: { skill: "writing-plans" } }),
      makeExecComplete(3000),
    ];
    const result = extractSkillTimeline(events);
    expect(result).toEqual([
      { name: "brainstorming", status: "completed", startedAt: 1000 },
      { name: "writing-plans", status: "completed", startedAt: 2000 },
    ]);
  });

  it("marks earlier skills completed, last skill active", () => {
    const events: SandboxEvent[] = [
      makeSkillCall({ timestamp: 1000, callId: "c1", args: { skill: "brainstorming" } }),
      makeSkillCall({ timestamp: 2000, callId: "c2", args: { skill: "writing-plans" } }),
      makeSkillCall({ timestamp: 3000, callId: "c3", args: { skill: "executing-plans" } }),
    ];
    const result = extractSkillTimeline(events);
    expect(result).toEqual([
      { name: "brainstorming", status: "completed", startedAt: 1000 },
      { name: "writing-plans", status: "completed", startedAt: 2000 },
      { name: "executing-plans", status: "active", startedAt: 3000 },
    ]);
  });

  it("extracts description from args if present", () => {
    const events: SandboxEvent[] = [
      makeSkillCall({
        timestamp: 1000,
        args: { skill: "brainstorming", args: "design the auth system" },
      }),
    ];
    const result = extractSkillTimeline(events);
    expect(result).toEqual([
      {
        name: "brainstorming",
        status: "active",
        startedAt: 1000,
        description: "design the auth system",
      },
    ]);
  });

  it("ignores non-tool_call events interspersed", () => {
    const events: SandboxEvent[] = [
      makeSkillCall({ timestamp: 1000, callId: "c1", args: { skill: "tdd" } }),
      {
        type: "token",
        content: "some text",
        messageId: "msg-1",
        sandboxId: "sb-1",
        timestamp: 1500,
      },
      {
        type: "tool_call",
        tool: "Read",
        args: { filePath: "foo.ts" },
        callId: "c2",
        messageId: "msg-1",
        sandboxId: "sb-1",
        timestamp: 1600,
      },
    ];
    const result = extractSkillTimeline(events);
    expect(result).toEqual([{ name: "tdd", status: "active", startedAt: 1000 }]);
  });
});
