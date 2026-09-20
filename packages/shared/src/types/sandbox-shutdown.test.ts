import { describe, expect, it } from "vitest";
import { sandboxShutdownSchema } from "./sandbox-shutdown";

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
