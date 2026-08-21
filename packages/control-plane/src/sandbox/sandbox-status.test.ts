import { describe, expect, it, vi } from "vitest";

import { coerceSandboxStatus } from "./sandbox-status";
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
  it.each(["pending", "spawning", "connecting", "warming", "ready", "stale", "stopped", "failed"])(
    "passes %s through unchanged",
    (status) => {
      const log = createLog();
      expect(coerceSandboxStatus(status, log)).toBe(status);
      expect(log.warn).not.toHaveBeenCalled();
    }
  );

  // The column is bare TEXT with no CHECK constraint, so the type system's
  // belief that it holds a SandboxStatus is an assumption, not a guarantee.
  // Degrading to `pending` keeps a spawn evaluable — throwing here would abort
  // the spawn over a value the caller could have survived — but it must be
  // loud, because a hit means something wrote a status we do not model.
  it("degrades an unrecognized status to pending and warns", () => {
    const log = createLog();
    expect(coerceSandboxStatus("running", log)).toBe("pending");
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
