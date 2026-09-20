import { describe, expect, it } from "vitest";
import { createSessionRequestSchema } from "./session-api";
import { sandboxSettingsSchema } from "./integrations";
import {
  parseSessionSandboxExecution,
  parseSnapshotRecoveryErrorCode,
  sessionSandboxExecutionSchema,
} from "./sandbox-execution";
import { serverMessageSchema } from "./server-messages";

describe("sandbox execution contracts", () => {
  it("retains preservation and Docker recovery state together on reconnect", () => {
    const sandboxExecution = {
      profile: "docker-v1",
      provider: "modal",
      cpuCores: 2,
      memoryMib: 4096,
    };
    const sandboxPreservation = {
      phase: "saved",
      expiresAtMs: null,
      drainAtMs: null,
      hasRecoveryPoint: true,
    };
    const decoded = serverMessageSchema.parse({
      type: "subscribed",
      participantId: "participant-1",
      session: {
        id: "session-1",
        title: null,
        repoOwner: "acme",
        repoName: "app",
        baseBranch: null,
        branchName: null,
        status: "active",
        sandboxStatus: "stopped",
        messageCount: 0,
        createdAt: 1,
        sandboxExecution,
        sandboxPreservation,
      },
      artifacts: [],
      timeline: { events: [], hasMore: false, cursor: null },
      promptQueue: [],
      snapshotRecoveryError: "runtime_incompatible",
    });

    expect(decoded).toMatchObject({
      session: { sandboxExecution, sandboxPreservation },
      snapshotRecoveryError: "runtime_incompatible",
    });
    expect(
      serverMessageSchema.parse({ type: "sandbox_preservation", preservation: sandboxPreservation })
    ).toEqual({ type: "sandbox_preservation", preservation: sandboxPreservation });
  });

  it("decodes only missing legacy execution as default", () => {
    expect(parseSessionSandboxExecution(null)).toEqual({ profile: "default" });
    for (const raw of [
      "null",
      "{}",
      "garbage",
      '{"profile":"unknown"}',
      '{"profile":"default","provider":"modal"}',
    ]) {
      expect(() => parseSessionSandboxExecution(raw)).toThrow();
    }
  });

  it("decodes snapshot recovery errors without dropping malformed persisted latches", () => {
    expect(parseSnapshotRecoveryErrorCode(null)).toBeNull();
    expect(parseSnapshotRecoveryErrorCode(undefined)).toBeNull();
    expect(parseSnapshotRecoveryErrorCode("artifact_missing")).toBe("artifact_missing");
    for (const raw of ["", "future_code", 1, {}]) {
      expect(parseSnapshotRecoveryErrorCode(raw)).toBe("invalid_snapshot_metadata");
    }
  });

  it("requires exact provider and finite positive Docker resources", () => {
    const docker = { profile: "docker-v1", provider: "modal", cpuCores: 2, memoryMib: 4096 };
    expect(sessionSandboxExecutionSchema.parse(docker)).toEqual(docker);
    for (const change of [
      { provider: "e2b" },
      { cpuCores: 0 },
      { cpuCores: Infinity },
      { memoryMib: 1.5 },
      { memoryMib: -1 },
      { vmRuntime: true },
    ]) {
      expect(sessionSandboxExecutionSchema.safeParse({ ...docker, ...change }).success).toBe(false);
    }
  });

  it("preserves optional Docker intent without coercion", () => {
    for (const schema of [sandboxSettingsSchema, createSessionRequestSchema]) {
      expect(schema.parse({}).dockerEnabled).toBeUndefined();
      expect(schema.parse({ dockerEnabled: false }).dockerEnabled).toBe(false);
      expect(schema.parse({ dockerEnabled: true }).dockerEnabled).toBe(true);
      for (const dockerEnabled of [null, "true", "false", 1]) {
        expect(schema.safeParse({ dockerEnabled }).success).toBe(false);
      }
    }
  });
});
