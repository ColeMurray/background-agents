import { describe, expect, it } from "vitest";
import {
  sandboxPromptBlockReason,
  sandboxShutdownSchema,
  type SandboxShutdownState,
} from "./sandbox-shutdown";

describe("sandboxShutdownSchema", () => {
  it("round-trips authoritative recovery actions while remaining rolling-compatible", () => {
    const base = { phase: "failed", expiresAtMs: null, drainAtMs: null } as const;
    expect(sandboxShutdownSchema.parse(base)).not.toHaveProperty("availableRecoveryActions");
    expect(
      sandboxShutdownSchema.parse({
        ...base,
        availableRecoveryActions: ["retry", "restore_saved"],
      }).availableRecoveryActions
    ).toEqual(["retry", "restore_saved"]);
    expect(
      sandboxShutdownSchema.safeParse({ ...base, availableRecoveryActions: ["resume"] }).success
    ).toBe(false);
  });
});

const state = (phase: SandboxShutdownState["phase"]): SandboxShutdownState => ({
  phase,
  expiresAtMs: null,
  drainAtMs: null,
});

describe("sandboxPromptBlockReason", () => {
  it.each(["failed", "unknown"] as const)(
    "blocks prompts in %s without a recovery action",
    (phase) => {
      expect(sandboxPromptBlockReason(state(phase))).toContain("start a new session");
    }
  );

  it("points to recovery when one is available", () => {
    expect(
      sandboxPromptBlockReason({ ...state("failed"), availableRecoveryActions: ["retry"] })
    ).toContain("Use an available recovery action");
  });

  it.each(["running", "draining", "capturing", "saved", "restoring"] as const)(
    "allows existing prompt queue behavior in %s",
    (phase) => {
      expect(sandboxPromptBlockReason(state(phase))).toBeNull();
    }
  );
});
