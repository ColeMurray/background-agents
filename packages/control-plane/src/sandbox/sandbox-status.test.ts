import { describe, expect, it, vi } from "vitest";

import { coerceSandboxStatus } from "./sandbox-status";
import { sandboxStatusSchema } from "@open-inspect/shared/types/sessions";
import type { Logger } from "../logger";

function createLog() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;
}

describe("coerceSandboxStatus", () => {
  it.each(sandboxStatusSchema.options)("passes %s through unchanged", (status) => {
    const log = createLog();
    expect(coerceSandboxStatus(status, log)).toBe(status);
    expect(log.warn).not.toHaveBeenCalled();
  });

  // The column is bare TEXT with no CHECK constraint, so the type system's
  // belief that it holds a SandboxStatus is an assumption, not a guarantee.
  // Degrading rather than throwing keeps the spawn evaluable, but it must be
  // loud: a hit means something wrote a status we do not model.
  // `failed` rather than `pending`: an unclassifiable sandbox must not be
  // treated as pre-spawn (reusable as if fresh) nor as stopped/stale (which
  // makes evaluateSpawnDecision try to resume it). `failed` refuses reuse and
  // still permits a clean spawn.
  it("degrades an unrecognized status to failed and warns", () => {
    const log = createLog();
    expect(coerceSandboxStatus("running", log)).toBe("failed");
    expect(log.warn).toHaveBeenCalledWith(
      "sandbox.status.unrecognized",
      expect.objectContaining({ status: "running" })
    );
  });

  it("treats a missing status as pending without warning", () => {
    const log = createLog();
    expect(coerceSandboxStatus(null, log)).toBe("pending");
    expect(coerceSandboxStatus(undefined, log)).toBe("pending");
    // Absent is the documented pre-spawn state, not corruption.
    expect(log.warn).not.toHaveBeenCalled();
  });
});
