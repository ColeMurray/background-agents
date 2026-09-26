import { describe, expect, it } from "vitest";
import type { SessionEvent } from "../types/sessions";
import { compactEvent, createCompactionState, MAX_COMPACT_OUTPUT_CHARS } from "./compaction";

function event(
  id: string,
  tool: string,
  args: Record<string, unknown>,
  output?: string
): SessionEvent {
  return {
    id,
    type: "tool_call",
    data: {
      tool,
      args,
      callId: id,
      status: "completed",
      ...(output === undefined ? {} : { output }),
    },
    messageId: "msg-1",
    createdAt: 1,
    timelineSequence: 1,
  };
}

describe("compactEvent", () => {
  it.each([
    ["Read", { file_path: "/workspace/sample.txt" }],
    ["read", { filePath: "/workspace/sample.txt" }],
  ])("removes %s file contents while keeping the path and status", (tool, args) => {
    const input = event("read-1", tool, args, "a".repeat(100));
    const result = compactEvent(input, createCompactionState());
    expect(result.data).toEqual({
      tool,
      args,
      callId: "read-1",
      status: "completed",
      compacted: { output: "file_read", originalChars: 100 },
    });
    expect(compactEvent(result, createCompactionState())).toBe(result);
    expect(input.data.output).toHaveLength(100);
  });

  it("truncates long output on a character boundary and leaves shorter output intact", () => {
    const state = createCompactionState();
    const output = "x".repeat(MAX_COMPACT_OUTPUT_CHARS - 2) + "😀end";
    const long = compactEvent(event("long", "bash", { command: "run" }, output), state);
    expect(long.data.output).toBe("x".repeat(MAX_COMPACT_OUTPUT_CHARS - 2) + "😀");
    expect(long.data.compacted).toEqual({ output: "truncated", originalChars: output.length });
    expect(compactEvent(long, state)).toBe(long);
    expect(
      compactEvent(
        event("split", "bash", {}, "x".repeat(MAX_COMPACT_OUTPUT_CHARS - 1) + "😀end"),
        state
      ).data.output
    ).toBe("x".repeat(MAX_COMPACT_OUTPUT_CHARS - 1));
    const short = event("short", "bash", {}, "ok");
    expect(compactEvent(short, state)).toBe(short);
  });

  it("references the latest identical raw output in read order, across tools", () => {
    const state = createCompactionState();
    const output = "result".repeat(MAX_COMPACT_OUTPUT_CHARS);
    const latest = compactEvent(event("latest", "bash", { command: "first" }, output), state);
    const earlier = compactEvent(event("earlier", "glob", { pattern: "*.ts" }, output), state);
    expect(latest.data.compacted).toEqual({ output: "truncated", originalChars: output.length });
    expect(earlier.data).toEqual({
      tool: "glob",
      args: { pattern: "*.ts" },
      callId: "earlier",
      status: "completed",
      compacted: { output: "ref", ref: "latest" },
    });
    expect(compactEvent(earlier, state)).toBe(earlier);
    expect(
      compactEvent(event("another", "bash", {}, output), createCompactionState()).data.compacted
    ).toEqual({ output: "truncated", originalChars: output.length });
  });

  it("keeps edit args and the final text in a sanitized two-harness trace", () => {
    const events: SessionEvent[] = [
      {
        ...event("prompt", "unused", {}),
        type: "user_message",
        data: { content: "Update a sample" },
      },
      event("claude-read", "Read", { file_path: "/workspace/sample.txt" }, "a".repeat(20_000)),
      event("claude-edit", "Edit", { old_string: "before", new_string: "after" }, "changed"),
      event("open-read", "read", { filePath: "/workspace/sample.txt" }, "b".repeat(20_000)),
      event(
        "open-edit",
        "apply_patch",
        { patchText: "*** Begin Patch\n+after\n*** End Patch" },
        "changed"
      ),
      event("open-write", "write", { content: "sample content" }, "written"),
      { ...event("final", "unused", {}), type: "token", data: { content: "Updated the sample." } },
      { ...event("complete", "unused", {}), type: "execution_complete", data: { success: true } },
    ];
    const state = createCompactionState();
    // Export processes newest first, then reverses for display.
    const compact = events
      .toReversed()
      .map((item) => compactEvent(item, state))
      .reverse();
    const fullBytes = new TextEncoder().encode(JSON.stringify(events)).byteLength;
    const compactBytes = new TextEncoder().encode(JSON.stringify(compact)).byteLength;
    expect(compactBytes).toBeLessThan(fullBytes / 4);
    expect(compact.map(({ id }) => id)).toEqual(events.map(({ id }) => id));
    expect(compact[0].data).toEqual({ content: "Update a sample" });
    expect(compact[2].data.args).toEqual({ old_string: "before", new_string: "after" });
    expect(compact[4].data.args).toEqual({ patchText: "*** Begin Patch\n+after\n*** End Patch" });
    expect(compact[5].data.args).toEqual({ content: "sample content" });
    expect(compact[6].data).toEqual({ content: "Updated the sample." });
    expect(compact[7].data).toEqual({ success: true });
  });

  it("passes unknown tools and non-tool events through unchanged", () => {
    const state = createCompactionState();
    const unknown = event("unknown", "new_tool", {}, "short");
    const token = { ...unknown, type: "token" as const, data: { content: "hi" } };
    expect(compactEvent(unknown, state)).toBe(unknown);
    expect(compactEvent(token, state)).toBe(token);
    expect(compactEvent(event("no-output", "Read", {}), state).data).not.toHaveProperty(
      "compacted"
    );
  });
});
