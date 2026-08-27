import { describe, expect, it } from "vitest";
import { extractLatestTasks } from "./tasks";
import type { SandboxEvent } from "@/types/session";

function toolCall(args: Record<string, unknown>, timestamp = 1): SandboxEvent {
  return {
    type: "tool_call",
    sandboxId: "sandbox-1",
    messageId: "message-1",
    timestamp,
    tool: "TodoWrite",
    args,
    callId: "call-1",
  };
}

describe("extractLatestTasks", () => {
  it("parses valid TodoWrite args", () => {
    expect(
      extractLatestTasks([
        toolCall({
          todos: [
            { content: "Find unsafe casts", status: "completed", activeForm: "Finding" },
            { content: "Patch cast", status: "in_progress" },
          ],
        }),
      ])
    ).toEqual([
      { content: "Find unsafe casts", status: "completed", activeForm: "Finding" },
      { content: "Patch cast", status: "in_progress", activeForm: undefined },
    ]);
  });

  it("rejects malformed TodoWrite args", () => {
    expect(extractLatestTasks([toolCall({ todos: "not an array" })])).toEqual([]);
    expect(extractLatestTasks([toolCall({ todos: [{ content: 42 }] })])).toEqual([]);
  });

  it("uses defaults for omitted todo fields", () => {
    expect(extractLatestTasks([toolCall({ todos: [{}] })])).toEqual([
      { content: "", status: "pending", activeForm: undefined },
    ]);
  });

  it("normalizes producer statuses without discarding the todo list", () => {
    expect(
      extractLatestTasks([
        toolCall({
          todos: [
            { content: "Stopped work", status: "cancelled" },
            { content: "Kept result", status: "completed" },
          ],
        }),
      ])
    ).toEqual([
      { content: "Stopped work", status: "pending", activeForm: undefined },
      { content: "Kept result", status: "completed", activeForm: undefined },
    ]);
  });
});
