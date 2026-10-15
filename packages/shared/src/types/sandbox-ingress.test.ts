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

describe("OpenCode plugin outcomes", () => {
  it("admits ordered plugin outcomes and non-fatal plugin warnings", () => {
    expect(
      sandboxIngressEventSchema.safeParse({
        type: "opencode_plugins",
        sandboxId: "s1",
        timestamp: 1,
        bootSeq: 2,
        plugins: [
          { spec: "audit@1.0.0", status: "loaded" },
          { spec: "broken@1.0.0", status: "skipped" },
        ],
      }).success
    ).toBe(true);
    expect(
      sandboxIngressEventSchema.safeParse({
        type: "warning",
        sandboxId: "s1",
        timestamp: 1,
        scope: "plugins",
        message: "Plugin broken@1.0.0 skipped: failed to load",
      }).success
    ).toBe(true);
  });
  it("rejects unsupported plugin outcome values", () => {
    expect(
      sandboxIngressEventSchema.safeParse({
        type: "opencode_plugins",
        sandboxId: "s1",
        timestamp: 1,
        plugins: [{ spec: "audit@1.0.0", status: "success" }],
      }).success
    ).toBe(false);
  });
});
