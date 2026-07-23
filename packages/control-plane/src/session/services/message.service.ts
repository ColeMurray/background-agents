import type { ArtifactRow } from "../types";
import { sessionAttachmentReferencesSchema, type SessionMessage } from "@open-inspect/shared";
import type { ArtifactResponse, ListEventsResponse } from "../../types";
import type { SessionRepository } from "../repository";
import type { SessionMessageQueue } from "../message-queue";
import { SessionEventStream, type SessionEventListRequest } from "../event-stream";
import { parseStoredSessionAttachments } from "../session-attachment-resolver";
import { z } from "zod";

export const enqueuePromptRequestSchema = z.object({
  content: z.string(),
  authorId: z.string(),
  source: z.string(),
  model: z.string().optional(),
  reasoningEffort: z.string().optional(),
  attachments: sessionAttachmentReferencesSchema.optional(),
  callbackContext: z.record(z.string(), z.unknown()).optional(),
  // Trusted SCM enrichment resolved by the router at prompt time.
  scmEnrichment: z
    .object({
      userId: z.string().nullable(),
      login: z.string().nullable(),
      name: z.string().nullable(),
      email: z.string().nullable(),
      accessTokenEncrypted: z.string().nullable(),
      refreshTokenEncrypted: z.string().nullable(),
      tokenExpiresAt: z.number().nullable(),
    })
    .optional(),
});

export type EnqueuePromptRequest = z.infer<typeof enqueuePromptRequestSchema>;

export type ListEventsRequest = SessionEventListRequest;

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
  private readonly eventStream: SessionEventStream;

  constructor(private readonly deps: MessageServiceDeps) {
    this.eventStream = new SessionEventStream(deps.repository);
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

  listArtifacts(): {
    artifacts: Array<{
      id: string;
      type: ArtifactRow["type"];
      url: string | null;
      metadata: Record<string, unknown> | null;
      createdAt: number;
      updatedAt: number;
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
        updatedAt: artifact.updated_at,
      })),
    };
  }

  getArtifact(artifactId: string): { artifact: ArtifactResponse | null } {
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
      cursor: messages.length > 0 ? messages[messages.length - 1].created_at.toString() : undefined,
      hasMore,
    };
  }
}
