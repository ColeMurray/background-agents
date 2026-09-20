import { describe, expect, it } from "vitest";
import { sandboxPreservationSchema } from "./sandbox-preservation";

describe("sandboxPreservationSchema", () => {
  it("round-trips authoritative recovery actions while remaining rolling-compatible", () => {
    const base = { phase: "failed", expiresAtMs: null, drainAtMs: null } as const;
    expect(sandboxPreservationSchema.parse(base)).not.toHaveProperty("availableRecoveryActions");
    expect(
      sandboxPreservationSchema.parse({
        ...base,
        availableRecoveryActions: ["retry", "restore_saved"],
      }).availableRecoveryActions
    ).toEqual(["retry", "restore_saved"]);
    expect(
      sandboxPreservationSchema.safeParse({ ...base, availableRecoveryActions: ["resume"] }).success
    ).toBe(false);
  });
});
