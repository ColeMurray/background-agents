import { describe, expect, it } from "vitest";
import type { SandboxStatus } from "@open-inspect/shared/types/sessions";
import {
  evaluateSandboxCommandAvailability,
  isSandboxAccessAvailable,
  isSandboxReconnectBlockedStatus,
  shouldStopSandboxOnSessionCancel,
  type SandboxCommandAvailability,
} from "./decisions";

// Explicit compatibility oracle, not expectations derived from the new predicates.
// Include warming even though it is a presentation-only member of the wire union.
const cases = {
  pending: ["booting", false, false, true],
  spawning: ["booting", false, false, true],
  connecting: ["booting", false, false, true],
  warming: ["booting", false, false, true],
  ready: ["dispatch", true, false, true],
  snapshotting: ["dispatch", false, false, true],
  stopped: ["unavailable", false, true, false],
  stale: ["unavailable", false, true, true],
  failed: ["unavailable", false, false, false],
} satisfies Record<SandboxStatus, [SandboxCommandAvailability, boolean, boolean, boolean]>;

describe("C1 lifecycle eligibility compatibility", () => {
  for (const status of Object.keys(cases) as SandboxStatus[]) {
    it(`preserves distinct dispatch/access/reconnect/cancel outcomes for ${status}`, () => {
      const [commands, access, blocksReconnect, cancel] = cases[status];
      expect(evaluateSandboxCommandAvailability(status)).toBe(commands);
      expect(isSandboxAccessAvailable(status)).toBe(access);
      expect(isSandboxReconnectBlockedStatus(status)).toBe(blocksReconnect);
      expect(shouldStopSandboxOnSessionCancel(status)).toBe(cancel);
    });
  }

  it("does not grant access or cancellation without a row", () => {
    expect(isSandboxAccessAvailable(undefined)).toBe(false);
    expect(shouldStopSandboxOnSessionCancel(undefined)).toBe(false);
  });
});
