import { describe, expect, it } from "vitest";
import { sandboxBootPhaseSchema, sandboxEventSchema, toSandboxBootPhase } from "./sandbox-events";

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

  it("strips a legacy output tail while parsing a failed phase", () => {
    const parsed = sandboxEventSchema.parse({
      type: "boot_progress",
      bootSeq: 7,
      phase: "start",
      status: "failed",
      elapsedMs: 1200,
      outputTail: ["npm ERR! missing script: start"],
      timestamp: 1_789_420_751.4,
    });
    expect(parsed).toEqual({
      type: "boot_progress",
      bootSeq: 7,
      phase: "start",
      status: "failed",
      elapsedMs: 1200,
      timestamp: 1_789_420_751.4,
    });
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

describe("sandboxBootPhaseSchema", () => {
  it("strips an output tail from a legacy persisted phase", () => {
    expect(
      sandboxBootPhaseSchema.parse({
        phase: "start",
        status: "failed",
        bootSeq: 6,
        sandboxId: "sb-1",
        detail: "start hook failed for acme/api",
        outputTail: ["legacy secret output"],
      })
    ).toEqual({
      phase: "start",
      status: "failed",
      bootSeq: 6,
      sandboxId: "sb-1",
      detail: "start hook failed for acme/api",
    });
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
      detail: "start hook failed for acme/api",
      sandboxId: "sb-1",
    });
    // What the control plane stores is what the snapshot schema accepts.
    expect(sandboxBootPhaseSchema.parse(phase)).toEqual(phase);
  });
});
