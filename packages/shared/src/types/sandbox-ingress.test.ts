import { describe, expect, it } from "vitest";
import { sandboxEventSchema, sandboxIngressEventSchema } from "./sandbox-events";

const event = { type: "artifact", sandboxId: "s1", timestamp: 1, url: "object-key" };

describe("sandbox artifact ingress", () => {
  it.each(["file", "unknown", "", null, 42])("rejects %s from live transports", (artifactType) => {
    expect(sandboxIngressEventSchema.safeParse({ ...event, artifactType }).success).toBe(false);
  });
  it.each(["pr", "preview", "branch", "screenshot", "video"])("admits %s", (artifactType) => {
    expect(sandboxIngressEventSchema.safeParse({ ...event, artifactType }).success).toBe(true);
  });
  it("retains server-registered files in broadcast and snapshot schemas", () => {
    expect(sandboxEventSchema.safeParse({ ...event, artifactType: "file" }).success).toBe(true);
  });
});

describe("sandbox command execution ingress", () => {
  it.each(["command_started", "command_output", "command_completed"] as const)(
    "admits %s through the canonical sandbox event boundary",
    (type) => {
      const base = { type, commandId: "cmd-1", sandboxId: "sandbox-1", timestamp: 1 };
      const executionEvent =
        type === "command_output"
          ? { ...base, sequence: 0, stream: "stdout", data: "ok\n" }
          : type === "command_completed"
            ? {
                ...base,
                outcome: "succeeded",
                exitCode: 0,
                signal: null,
                lastSequence: 0,
              }
            : base;
      expect(sandboxIngressEventSchema.safeParse(executionEvent).success).toBe(true);
      expect(sandboxEventSchema.safeParse(executionEvent).success).toBe(true);
    }
  );
});
