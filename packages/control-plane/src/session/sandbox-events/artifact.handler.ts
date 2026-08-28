import type { SessionArtifact } from "@open-inspect/shared/types/artifacts";
import type { SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import { generateId } from "../../auth/crypto";
import type { ArtifactRepository } from "../artifact-repository";
import { assertArtifactType } from "../artifacts";
import type { EventRepository } from "../event-repository";
import type { SessionMessenger } from "../messenger";
import type { SandboxEventContext } from "./context";

/**
 * Artifact family: materialize a sandbox-reported artifact (PR, preview,
 * media, ...) into the artifact table and the timeline. The persisted and
 * broadcast event is the augmented copy — normalized type, a guaranteed id,
 * and the resolved message attribution — not the raw wire event.
 */
export class SandboxArtifactEventHandler {
  constructor(
    private readonly artifactRepository: ArtifactRepository,
    private readonly eventRepository: EventRepository,
    private readonly messenger: SessionMessenger,
    private readonly updateLastActivity: (timestamp: number) => void
  ) {}

  handleArtifact(
    event: Extract<SandboxEvent, { type: "artifact" }>,
    context: SandboxEventContext
  ): void {
    this.updateLastActivity(context.now);

    const artifactType = assertArtifactType(event.artifactType);
    const artifactId =
      typeof event.artifactId === "string" && event.artifactId.length > 0
        ? event.artifactId
        : generateId();
    const augmentedEvent: Extract<SandboxEvent, { type: "artifact" }> = {
      ...event,
      artifactType,
      artifactId,
      messageId: context.messageId ?? undefined,
    };
    const artifact: SessionArtifact = {
      id: artifactId,
      type: artifactType,
      url: event.url,
      metadata: event.metadata ?? null,
      createdAt: context.now,
      updatedAt: context.now,
    };

    this.artifactRepository.createArtifact({
      id: artifact.id,
      type: artifact.type,
      url: artifact.url,
      metadata: artifact.metadata ? JSON.stringify(artifact.metadata) : null,
      createdAt: context.now,
    });
    this.eventRepository.createEvent({
      id: generateId(),
      type: event.type,
      data: JSON.stringify(augmentedEvent),
      messageId: context.messageId,
      createdAt: context.now,
    });

    this.messenger.broadcast({ type: "artifact_created", artifact });
    this.messenger.broadcast({ type: "sandbox_event", event: augmentedEvent });
  }
}
