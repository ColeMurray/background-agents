import { describe, expect, it } from "vitest";
import { sandboxEventSchema } from "./sandbox-events";

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
