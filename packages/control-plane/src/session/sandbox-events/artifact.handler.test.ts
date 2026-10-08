import { describe, expect, it, vi } from "vitest";
import type { ArtifactRepository } from "../artifact-repository";
import type { EventRepository } from "../event-repository";
import { SandboxArtifactEventHandler } from "./artifact.handler";

describe("SandboxArtifactEventHandler", () => {
  it("rejects unregistered file events from WebSocket ingress without persistence or broadcast", () => {
    const createArtifact = vi.fn();
    const createEvent = vi.fn();
    const broadcast = vi.fn();
    const updateLastActivity = vi.fn();
    const handler = new SandboxArtifactEventHandler(
      { createArtifact } as unknown as ArtifactRepository,
      { createEvent } as unknown as EventRepository,
      { broadcast, sendToSandbox: vi.fn() },
      updateLastActivity
    );
    expect(() =>
      handler.handleArtifact(
        {
          type: "artifact",
          artifactType: "file",
          artifactId: "f1",
          url: "sessions/s1/files/f1",
          sandboxId: "sb1",
          timestamp: 1,
        },
        { now: 1000, messageId: "m1", processingMessage: { id: "m1" } }
      )
    ).toThrow("Files require validated upload registration");
    expect(createArtifact).not.toHaveBeenCalled();
    expect(createEvent).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
    expect(updateLastActivity).not.toHaveBeenCalled();
  });
});
