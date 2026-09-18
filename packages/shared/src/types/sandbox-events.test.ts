import { describe, expect, it } from "vitest";
import {
  SANDBOX_ERROR_BODY_MAX_BYTES,
  SANDBOX_OUTPUT_TAIL_MAX_CHARS,
  SANDBOX_OUTPUT_TAIL_MAX_LINES,
  sandboxBootPhaseSchema,
  sandboxEventSchema,
  sandboxOutputTailSchema,
  toSandboxBootPhase,
} from "./sandbox-events";

describe("boot_progress sandbox event", () => {
  it("parses a phase report with its repository and sequence", () => {
    const parsed = sandboxEventSchema.parse({
      type: "boot_progress",
      bootSeq: 3,
      phase: "setup",
      status: "started",
      repoOwner: "acme",
      repoName: "api",
      sandboxId: "sb-1",
      timestamp: 1_789_420_000.12,
    });
    expect(parsed.type).toBe("boot_progress");
    if (parsed.type === "boot_progress") {
      expect(parsed.phase).toBe("setup");
      expect(parsed.bootSeq).toBe(3);
    }
  });

  it("parses a failed phase carrying the script's output tail", () => {
    const parsed = sandboxEventSchema.parse({
      type: "boot_progress",
      bootSeq: 7,
      phase: "start",
      status: "failed",
      elapsedMs: 1200,
      outputTail: ["npm ERR! missing script: start"],
      timestamp: 1_789_420_751.4,
    });
    expect(parsed.type).toBe("boot_progress");
  });

  it("rejects an unknown phase", () => {
    expect(
      sandboxEventSchema.safeParse({
        type: "boot_progress",
        bootSeq: 1,
        phase: "compile",
        status: "started",
        timestamp: 1,
      }).success
    ).toBe(false);
  });
});

describe("sandboxOutputTailSchema", () => {
  it("accepts a full tail at both bounds", () => {
    const perLine = Math.floor(SANDBOX_OUTPUT_TAIL_MAX_CHARS / SANDBOX_OUTPUT_TAIL_MAX_LINES);
    const lines = Array.from({ length: SANDBOX_OUTPUT_TAIL_MAX_LINES }, () => "x".repeat(perLine));
    expect(sandboxOutputTailSchema.safeParse(lines).success).toBe(true);
  });

  it("rejects one line too many", () => {
    const lines = Array.from({ length: SANDBOX_OUTPUT_TAIL_MAX_LINES + 1 }, () => "x");
    expect(sandboxOutputTailSchema.safeParse(lines).success).toBe(false);
  });

  it("rejects a tail whose lines together exceed the character budget", () => {
    const lines = Array.from({ length: 9 }, () => "x".repeat(1024));
    expect(sandboxOutputTailSchema.safeParse(lines).success).toBe(false);
  });

  it("fits a full tail inside the sandbox-error body budget once JSON-escaped", () => {
    // Every character a quote: the worst legal escape doubles the tail.
    const perLine = Math.floor(SANDBOX_OUTPUT_TAIL_MAX_CHARS / SANDBOX_OUTPUT_TAIL_MAX_LINES);
    const lines = Array.from({ length: SANDBOX_OUTPUT_TAIL_MAX_LINES }, () => '"'.repeat(perLine));
    const body = JSON.stringify({
      error: "e".repeat(1000),
      fatal: true,
      phase: "setup",
      bootSeq: 3,
      repoOwner: "o".repeat(39),
      repoName: "n".repeat(100),
      outputTail: lines,
    });
    expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(
      SANDBOX_ERROR_BODY_MAX_BYTES
    );
  });
});

describe("toSandboxBootPhase", () => {
  it("keeps everything the event reports except its envelope", () => {
    const phase = toSandboxBootPhase({
      type: "boot_progress",
      bootSeq: 6,
      phase: "start",
      status: "failed",
      repoOwner: "acme",
      repoName: "api",
      outputTail: ["npm ERR! missing script: dev"],
      detail: "start hook failed for acme/api",
      sandboxId: "sb-1",
      timestamp: 9,
      ackId: "ack-1",
    });

    expect(phase).toEqual({
      bootSeq: 6,
      phase: "start",
      status: "failed",
      repoOwner: "acme",
      repoName: "api",
      outputTail: ["npm ERR! missing script: dev"],
      detail: "start hook failed for acme/api",
      sandboxId: "sb-1",
    });
    // What the control plane stores is what the snapshot schema accepts.
    expect(sandboxBootPhaseSchema.parse(phase)).toEqual(phase);
  });
});
