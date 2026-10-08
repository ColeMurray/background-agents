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
