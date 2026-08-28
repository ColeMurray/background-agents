import { describe, expect, it } from "vitest";
import {
  BOOT_FAILURE_CODES,
  BOOT_FAILURE_MESSAGE_MAX_LENGTH,
  BOOT_PHASES,
  SANDBOX_EVENT_ACK_ID_MAX_LENGTH,
  sandboxBootFailedEventSchema,
  sandboxBootPhaseEventSchema,
  sandboxEventSchema,
  type BootFailureCode,
  type BootPhase,
} from "./sandbox-events";

const baseEvent = {
  sandboxId: "sandbox-1",
  timestamp: 123,
};

describe("sandbox boot event contracts", () => {
  it.each(["booting", "ready"] as const)("parses %s heartbeats", (status) => {
    expect(
      sandboxEventSchema.parse({
        ...baseEvent,
        type: "heartbeat",
        status,
        phase: status === "booting" ? "repository_sync" : undefined,
      })
    ).toMatchObject({ type: "heartbeat", status });
  });

  it("rejects legacy and unknown heartbeat statuses", () => {
    expect(
      sandboxEventSchema.safeParse({ ...baseEvent, type: "heartbeat", status: "connecting" })
        .success
    ).toBe(false);
    expect(
      sandboxEventSchema.safeParse({ ...baseEvent, type: "heartbeat", status: "future" }).success
    ).toBe(false);
  });

  it("exports and accepts the canonical boot phases", () => {
    const phases: readonly BootPhase[] = BOOT_PHASES;

    for (const phase of phases) {
      expect(
        sandboxBootPhaseEventSchema.safeParse({ ...baseEvent, type: "boot_phase", phase }).success
      ).toBe(true);
    }
  });

  it("includes boot phase events in the canonical sandbox event union", () => {
    expect(
      sandboxEventSchema.parse({
        ...baseEvent,
        type: "boot_phase",
        phase: "repository_sync",
        detailCode: "clone_primary",
      })
    ).toMatchObject({ type: "boot_phase", phase: "repository_sync" });
  });

  it("rejects unknown boot phases on heartbeats and phase events", () => {
    expect(
      sandboxEventSchema.safeParse({
        ...baseEvent,
        type: "heartbeat",
        status: "booting",
        phase: "future_phase",
      }).success
    ).toBe(false);
    expect(
      sandboxBootPhaseEventSchema.safeParse({
        ...baseEvent,
        type: "boot_phase",
        phase: "future_phase",
      }).success
    ).toBe(false);
  });

  it("preserves ready-event compatibility", () => {
    expect(
      sandboxEventSchema.safeParse({ ...baseEvent, type: "ready", opencodeSessionId: null }).success
    ).toBe(true);
  });

  it("exports and accepts only allowlisted boot failure codes", () => {
    const codes: readonly BootFailureCode[] = BOOT_FAILURE_CODES;

    for (const code of codes) {
      expect(
        sandboxBootFailedEventSchema.safeParse({
          ...baseEvent,
          type: "boot_failed",
          ackId: "ack-1",
          phase: "opencode_health",
          code,
        }).success
      ).toBe(true);
    }

    expect(
      sandboxBootFailedEventSchema.safeParse({
        ...baseEvent,
        type: "boot_failed",
        ackId: "ack-1",
        phase: "opencode_health",
        code: "unknown_failure",
      }).success
    ).toBe(false);
  });

  it("includes boot failures in the canonical sandbox event union", () => {
    expect(
      sandboxEventSchema.parse({
        ...baseEvent,
        type: "boot_failed",
        ackId: "boot-failure-1",
        phase: "opencode_health",
        code: "opencode_health_timeout",
      })
    ).toMatchObject({ type: "boot_failed", ackId: "boot-failure-1" });
  });

  it("requires a non-empty bounded acknowledgement id for boot failures", () => {
    const event = {
      ...baseEvent,
      type: "boot_failed",
      phase: "repository_sync",
      code: "repository_boot_failed",
    };

    expect(sandboxBootFailedEventSchema.safeParse(event).success).toBe(false);
    expect(sandboxBootFailedEventSchema.safeParse({ ...event, ackId: "" }).success).toBe(false);
    expect(
      sandboxBootFailedEventSchema.safeParse({
        ...event,
        ackId: "a".repeat(SANDBOX_EVENT_ACK_ID_MAX_LENGTH),
      }).success
    ).toBe(true);
    expect(
      sandboxBootFailedEventSchema.safeParse({
        ...event,
        ackId: "a".repeat(SANDBOX_EVENT_ACK_ID_MAX_LENGTH + 1),
      }).success
    ).toBe(false);
  });

  it("bounds optional user-safe boot failure messages", () => {
    const event = {
      ...baseEvent,
      type: "boot_failed",
      ackId: "ack-1",
      phase: "repository_sync",
      code: "repository_boot_failed",
    };

    expect(
      sandboxBootFailedEventSchema.safeParse({
        ...event,
        message: "m".repeat(BOOT_FAILURE_MESSAGE_MAX_LENGTH),
      }).success
    ).toBe(true);
    expect(
      sandboxBootFailedEventSchema.safeParse({
        ...event,
        message: "m".repeat(BOOT_FAILURE_MESSAGE_MAX_LENGTH + 1),
      }).success
    ).toBe(false);
  });
});
