import type { ArtifactRow, EventRow, MessageRow } from "../types";
import type { SessionRepository } from "../repository";
import type { SessionMessageQueue } from "../message-queue";

export interface EnqueuePromptRequest {
  content: string;
  authorId: string;
  source: string;
  model?: string;
  reasoningEffort?: string;
  attachments?: Array<{ type: string; name: string; url?: string }>;
  callbackContext?: Record<string, unknown>;
}

export interface ListEventsRequest {
  cursor: string | null;
  limit: number;
  type: string | null;
  messageId: string | null;
}

export interface ListMessagesRequest {
  cursor: string | null;
  limit: number;
  status: string | null;
}

interface MessageServiceDeps {
  repository: SessionRepository;
  messageQueue: SessionMessageQueue;
  stopExecution: () => Promise<void>;
  parseArtifactMetadata: (
    artifact: Pick<ArtifactRow, "id" | "metadata">
  ) => Record<string, unknown> | null;
}

export class MessageService {
  constructor(private readonly deps: MessageServiceDeps) {}

  enqueuePrompt(request: EnqueuePromptRequest): Promise<{ messageId: string; status: "queued" }> {
    return this.deps.messageQueue.enqueuePromptFromApi(request);
  }

  async stop(): Promise<{ status: "stopping" }> {
    await this.deps.stopExecution();
    return { status: "stopping" };
  }

  listEvents(request: ListEventsRequest): {
    events: EventRow[];
    cursor: string | undefined;
    hasMore: boolean;
  } {
    const events = this.deps.repository.listEvents({
      cursor: request.cursor,
      limit: request.limit,
      type: request.type,
      messageId: request.messageId,
    });
    const hasMore = events.length > request.limit;
    if (hasMore) events.pop();

    return {
      events,
      cursor: events.length > 0 ? events[events.length - 1].created_at.toString() : undefined,
      hasMore,
    };
  }

  listArtifacts(): {
    artifacts: Array<{
      id: string;
      type: ArtifactRow["type"];
      url: string | null;
      metadata: Record<string, unknown> | null;
      createdAt: number;
    }>;
  } {
    const artifacts = this.deps.repository.listArtifacts();
    return {
      artifacts: artifacts.map((artifact) => ({
        id: artifact.id,
        type: artifact.type,
        url: artifact.url,
        metadata: this.deps.parseArtifactMetadata(artifact),
        createdAt: artifact.created_at,
      })),
    };
  }

  getArtifact(artifactId: string): {
    artifact: {
      id: string;
      type: ArtifactRow["type"];
      url: string | null;
      metadata: Record<string, unknown> | null;
      createdAt: number;
    } | null;
  } {
    const artifact = this.deps.repository.getArtifactById(artifactId);
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
      },
    };
  }

  listMessages(request: ListMessagesRequest): {
    messages: MessageRow[];
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
      messages,
      cursor: messages.length > 0 ? messages[messages.length - 1].created_at.toString() : undefined,
      hasMore,
    };
  }
}
