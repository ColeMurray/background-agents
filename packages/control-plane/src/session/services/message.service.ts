import type { ArtifactRow, MessageRow } from "../types";
import type { SessionMessage } from "@open-inspect/shared/types/sessions";
import { encodeCreatedAtCursor, type CreatedAtCursor } from "../../created-at-cursor";
import type { ListEventsResponse } from "@open-inspect/shared/types/sandbox-events";
import type { NormalizedArtifactResponse } from "../artifacts";
import type { MessageRepository } from "../message-repository";
import type { ArtifactRepository } from "../artifact-repository";
import type { EventRepository } from "../event-repository";
import type { SessionMessageQueue } from "../message-queue";
import type { EnqueuePromptRequest } from "../enqueue-prompt-contract";
import type { EventTimelineCursor } from "../event-cursor";
import { SessionEventStream, toSessionEvent, type SessionEventListRequest } from "../event-stream";
import { parseStoredSessionAttachments } from "../session-attachment-resolver";
import type { MessageListCursor } from "../message-cursor";
import {
  MAX_INCLUDED_BYTES_PER_SESSION,
  type SessionMessagePage,
  type SessionTrace,
  type SessionTraceCollection,
  type SessionTraceExport,
} from "../contracts";
import type { StepUsageCursor, UsageRepository } from "../usage-repository";

/** Rows per repository read while exporting a trace. */
export const TRACE_EXPORT_PAGE_SIZE = 100;
/** Repository reads one trace export may make, across every collection it includes. */
export const MAX_INCLUDED_PAGES_PER_SESSION = 25;

export type ListEventsRequest = SessionEventListRequest;

export interface ListMessagesRequest {
  cursor: MessageListCursor | null;
  limit: number;
  status: string | null;
}

interface MessageServiceDeps {
  repository: MessageRepository;
  eventRepository: EventRepository;
  artifactRepository: ArtifactRepository;
  usageRepository: UsageRepository;
  messageQueue: SessionMessageQueue;
  stopExecution: () => Promise<void>;
  parseArtifactMetadata: (
    artifact: Pick<ArtifactRow, "id" | "metadata">
  ) => Record<string, unknown> | null;
  transaction: <T>(closure: () => T) => T;
}

type TraceExportFailure = Extract<SessionTraceExport, { ok: false }>;
type TracePage<T, TCursor> = { items: T[]; nextCursor: TCursor | null };

const encoder = new TextEncoder();

function serializedBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).byteLength;
}

/** The byte budget and page cap that one trace export shares across its collections. */
class TraceExportBudget {
  private pages = 0;
  private bytes: number;

  constructor(include: readonly SessionTraceCollection[]) {
    // Charge the response envelope up front, so the whole serialized response
    // fits the budget and not only its items.
    const emptyTrace = Object.fromEntries(include.map((collection) => [collection, []]));
    this.bytes = serializedBytes({ ok: true, trace: emptyTrace });
  }

  /** Reads a collection page by page until it ends or a shared limit is spent. */
  readAll<T, TCursor>(
    readPage: (cursor: TCursor | null) => TracePage<T, TCursor>
  ): { ok: true; items: T[] } | TraceExportFailure {
    const items: T[] = [];
    let cursor: TCursor | null = null;
    while (this.pages < MAX_INCLUDED_PAGES_PER_SESSION) {
      this.pages++;
      const page = readPage(cursor);
      for (const item of page.items) {
        // Each item also costs at most one separating comma.
        this.bytes += serializedBytes(item) + 1;
        if (this.bytes > MAX_INCLUDED_BYTES_PER_SESSION) {
          return { ok: false, reason: "message_budget_exceeded" };
        }
        items.push(item);
      }
      if (page.nextCursor === null) return { ok: true, items };
      cursor = page.nextCursor;
    }
    return { ok: false, reason: "page_cap_reached" };
  }
}

function toSessionMessage(message: MessageRow): SessionMessage {
  return {
    id: message.id,
    authorId: message.author_id,
    content: message.content,
    source: message.source,
    attachments: parseStoredSessionAttachments(message.attachments) ?? null,
    status: message.status,
    createdAt: message.created_at,
    startedAt: message.started_at,
    completedAt: message.completed_at,
  };
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

  listArtifacts(): { artifacts: NormalizedArtifactResponse[] } {
    const artifacts = this.deps.artifactRepository.listArtifacts();
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

  listMessages(request: ListMessagesRequest): SessionMessagePage {
    const messages = this.deps.repository.listMessages({
      cursor: request.cursor,
      limit: request.limit,
      status: request.status,
    });
    const hasMore = messages.length > request.limit;
    if (hasMore) messages.pop();

    const responseMessages = messages.map(toSessionMessage);
    const last = messages.at(-1);
    const cursor = last
      ? encodeCreatedAtCursor({ createdAt: last.created_at, id: last.id })
      : undefined;

    if (hasMore) {
      if (!cursor) throw new Error("A non-terminal message page must contain a cursor");
      return { messages: responseMessages, cursor, hasMore: true };
    }
    return { messages: responseMessages, cursor, hasMore: false };
  }

  /**
   * Reads the requested collections in one storage transaction, so a running
   * session cannot change the trace between collections or pages. One byte
   * budget and one page cap bound them together.
   */
  exportTrace(include: readonly SessionTraceCollection[]): SessionTraceExport {
    return this.deps.transaction((): SessionTraceExport => {
      const budget = new TraceExportBudget(include);
      const trace: SessionTrace = {};
      if (include.includes("messages")) {
        // Newest first, the order the schema 1 export has always used.
        const messages = budget.readAll((cursor: CreatedAtCursor | null) => {
          const rows = this.deps.repository.listMessages({
            cursor,
            limit: TRACE_EXPORT_PAGE_SIZE,
            status: null,
          });
          const page = rows.slice(0, TRACE_EXPORT_PAGE_SIZE);
          const last = page.at(-1);
          return {
            items: page.map(toSessionMessage),
            nextCursor:
              rows.length > TRACE_EXPORT_PAGE_SIZE && last
                ? { createdAt: last.created_at, id: last.id }
                : null,
          };
        });
        if (!messages.ok) return messages;
        trace.messages = messages.items;
      }
      if (include.includes("events")) {
        const events = budget.readAll((cursor: EventTimelineCursor | null) => {
          const page = this.deps.eventRepository.listEventPage({
            cursor,
            limit: TRACE_EXPORT_PAGE_SIZE,
          });
          return {
            items: page.events.map(toSessionEvent),
            nextCursor: page.hasMore ? page.nextCursor : null,
          };
        });
        if (!events.ok) return events;
        // Pages run newest first; the trace lists events in timeline order.
        trace.events = events.items.reverse();
      }
      if (include.includes("usage")) {
        const usage = budget.readAll((cursor: StepUsageCursor | null) =>
          this.deps.usageRepository.listStepUsage(cursor, TRACE_EXPORT_PAGE_SIZE)
        );
        if (!usage.ok) return usage;
        // Pages run newest first; the trace lists steps in timeline order.
        trace.usage = usage.items.reverse();
      }
      return { ok: true, trace };
    });
  }
}
