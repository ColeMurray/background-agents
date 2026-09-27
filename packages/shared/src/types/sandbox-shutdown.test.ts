import { describe, expect, it } from "vitest";
import { z } from "zod";
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

  it("carries discard beside the action list so clients that predate it still parse the state", () => {
    const projected = {
      phase: "unknown",
      expiresAtMs: null,
      drainAtMs: null,
      availableRecoveryActions: ["retry"],
      discardAvailable: true,
    };
    const predatingDiscard = sandboxShutdownSchema.omit({ discardAvailable: true }).extend({
      availableRecoveryActions: z.array(z.enum(["retry", "restore_saved"])).optional(),
    });

    expect(predatingDiscard.safeParse(projected).success).toBe(true);
    expect(sandboxShutdownSchema.parse(projected)).toMatchObject({
      availableRecoveryActions: ["retry"],
      discardAvailable: true,
    });
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
    expect(sandboxPromptBlockReason({ ...state("unknown"), discardAvailable: true })).toContain(
      "Use an available recovery action"
    );
  });

  it.each(["running", "draining", "capturing", "saved", "restoring"] as const)(
    "allows existing prompt queue behavior in %s",
    (phase) => {
      expect(sandboxPromptBlockReason(state(phase))).toBeNull();
    }
  );
});
