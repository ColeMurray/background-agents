import type { ArtifactRow } from "../types";
import type { SessionMessage } from "@open-inspect/shared/types/sessions";
import type { ListEventsResponse } from "@open-inspect/shared/types/sandbox-events";
import type { NormalizedArtifactResponse } from "../artifacts";
import type { MessageRepository } from "../message-repository";
import type { ArtifactRepository } from "../artifact-repository";
import type { EventRepository, ListEventChangesOptions } from "../event-repository";
import type { SessionMessageQueue } from "../message-queue";
import type { EnqueuePromptRequest } from "../enqueue-prompt-contract";
import { SessionEventStream, type SessionEventListRequest } from "../event-stream";
import type { SessionEventChangePage } from "../contracts";
import { parseStoredSessionAttachments } from "../session-attachment-resolver";
import { encodeCreatedAtIdCursor, type CreatedAtIdCursor } from "../list-cursor";

export type ListEventsRequest = SessionEventListRequest;

export interface ListMessagesRequest {
  cursor: CreatedAtIdCursor | null;
  limit: number;
  status: string | null;
}

interface MessageServiceDeps {
  repository: MessageRepository;
  eventRepository: EventRepository;
  artifactRepository: ArtifactRepository;
  messageQueue: SessionMessageQueue;
  stopExecution: () => Promise<void>;
  parseArtifactMetadata: (
    artifact: Pick<ArtifactRow, "id" | "metadata">
  ) => Record<string, unknown> | null;
}

export class MessageService {
  private readonly eventStream: SessionEventStream;

  constructor(private readonly deps: MessageServiceDeps) {
    this.eventStream = new SessionEventStream(deps.eventRepository);
  }

  enqueuePrompt(request: EnqueuePromptRequest): Promise<{ messageId: string; status: "queued" }> {
    return this.deps.messageQueue.enqueuePromptFromApi(request);
  }

  async stop(): Promise<{ status: "stopping" }> {
    await this.deps.stopExecution();
    return { status: "stopping" };
  }

  listEvents(request: ListEventsRequest): ListEventsResponse {
    return this.eventStream.listEvents(request);
  }

  listEventChanges(request: ListEventChangesOptions): SessionEventChangePage {
    return this.eventStream.listEventChanges(request);
  }

  listArtifacts(request?: { cursor: CreatedAtIdCursor | null; limit: number }): {
    artifacts: NormalizedArtifactResponse[];
    cursor?: string;
    hasMore?: boolean;
  } {
    const artifacts = this.deps.artifactRepository.listArtifacts(request);
    const hasMore = request !== undefined && artifacts.length > request.limit;
    if (hasMore) artifacts.pop();
    const last = artifacts.at(-1);
    return {
      artifacts: artifacts.map((artifact) => ({
        id: artifact.id,
        type: artifact.type,
        url: artifact.url,
        metadata: this.deps.parseArtifactMetadata(artifact),
        createdAt: artifact.created_at,
        updatedAt: artifact.updated_at,
      })),
      ...(request ? { hasMore } : {}),
      ...(hasMore && last
        ? { cursor: encodeCreatedAtIdCursor({ createdAt: last.created_at, id: last.id }) }
        : {}),
    };
  }

  getArtifact(artifactId: string): { artifact: NormalizedArtifactResponse | null } {
    const artifact = this.deps.artifactRepository.getArtifactById(artifactId);
    if (!artifact) {
      return { artifact: null };
    }

    return {
      artifact: {
        id: artifact.id,
        type: artifact.type,
        url: artifact.url,
        metadata: this.deps.parseArtifactMetadata(artifact),
        createdAt: artifact.created_at,
        updatedAt: artifact.updated_at,
      },
    };
  }

  listMessages(request: ListMessagesRequest): {
    messages: SessionMessage[];
    cursor: string | undefined;
    hasMore: boolean;
  } {
    const messages = this.deps.repository.listMessages({
      cursor: request.cursor,
      limit: request.limit,
      status: request.status,
    });
    const hasMore = messages.length > request.limit;
    if (hasMore) messages.pop();

    return {
      messages: messages.map((message) => ({
        id: message.id,
        authorId: message.author_id,
        content: message.content,
        source: message.source,
        attachments: parseStoredSessionAttachments(message.attachments) ?? null,
        status: message.status,
        createdAt: message.created_at,
        startedAt: message.started_at,
        completedAt: message.completed_at,
      })),
      cursor:
        hasMore && messages.length > 0
          ? encodeCreatedAtIdCursor({
              createdAt: messages[messages.length - 1]!.created_at,
              id: messages[messages.length - 1]!.id,
            })
          : undefined,
      hasMore,
    };
  }
}
