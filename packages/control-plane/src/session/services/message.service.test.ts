import { describe, expect, it, vi } from "vitest";
import type { ArtifactRow, EventRow, MessageRow } from "../types";
import type { SessionRepository } from "../repository";
import type { SessionMessageQueue } from "../message-queue";
import { MessageService } from "./message.service";

function createService() {
  const repository = {
    listEvents: vi.fn(),
    listArtifacts: vi.fn(),
    listMessages: vi.fn(),
  } as unknown as SessionRepository;

  const messageQueue = {
    enqueuePromptFromApi: vi.fn(),
  } as unknown as SessionMessageQueue;

  const stopExecution = vi.fn();
  const parseArtifactMetadata = vi.fn();

  return {
    service: new MessageService({
      repository,
      messageQueue,
      stopExecution,
      parseArtifactMetadata,
    }),
    repository,
    messageQueue,
    stopExecution,
    parseArtifactMetadata,
  };
}

describe("MessageService", () => {
  it("delegates enqueuePrompt to SessionMessageQueue", async () => {
    const { service, messageQueue } = createService();
    vi.mocked(messageQueue.enqueuePromptFromApi).mockResolvedValue({
      messageId: "msg-1",
      status: "queued",
    });

    const result = await service.enqueuePrompt({
      content: "hello",
      authorId: "user-1",
      source: "web",
    });

    expect(result).toEqual({ messageId: "msg-1", status: "queued" });
    expect(messageQueue.enqueuePromptFromApi).toHaveBeenCalledWith({
      content: "hello",
      authorId: "user-1",
      source: "web",
    });
  });

  it("stops execution and returns stopping status", async () => {
    const { service, stopExecution } = createService();
    const result = await service.stop();

    expect(result).toEqual({ status: "stopping" });
    expect(stopExecution).toHaveBeenCalledTimes(1);
  });

  it("paginates events with hasMore and cursor", () => {
    const { service, repository } = createService();
    const events: EventRow[] = [
      { id: "e3", type: "token", data: "{}", message_id: "m1", created_at: 3000 },
      { id: "e2", type: "token", data: "{}", message_id: "m1", created_at: 2000 },
      { id: "e1", type: "token", data: "{}", message_id: "m1", created_at: 1000 },
    ];
    vi.mocked(repository.listEvents).mockReturnValue(events);

    const result = service.listEvents({ cursor: null, limit: 2, type: "token", messageId: "m1" });

    expect(result.hasMore).toBe(true);
    expect(result.cursor).toBe("2000");
    expect(result.events).toHaveLength(2);
    expect(repository.listEvents).toHaveBeenCalledWith({
      cursor: null,
      limit: 2,
      type: "token",
      messageId: "m1",
    });
  });

  it("maps artifacts and delegates metadata parsing", () => {
    const { service, repository, parseArtifactMetadata } = createService();
    const artifacts: ArtifactRow[] = [
      {
        id: "a1",
        type: "pr",
        url: "https://example.com/pr/1",
        metadata: '{"key":"value"}',
        created_at: 1000,
      },
    ];
    vi.mocked(repository.listArtifacts).mockReturnValue(artifacts);
    vi.mocked(parseArtifactMetadata).mockReturnValue({ key: "value" });

    const result = service.listArtifacts();

    expect(result).toEqual({
      artifacts: [
        {
          id: "a1",
          type: "pr",
          url: "https://example.com/pr/1",
          metadata: { key: "value" },
          createdAt: 1000,
        },
      ],
    });
    expect(parseArtifactMetadata).toHaveBeenCalledWith(artifacts[0]);
  });

  it("paginates messages with hasMore and cursor", () => {
    const { service, repository } = createService();
    const messages: MessageRow[] = [
      {
        id: "m3",
        author_id: "p1",
        content: "3",
        source: "web",
        model: null,
        reasoning_effort: null,
        attachments: null,
        callback_context: null,
        status: "pending",
        error_message: null,
        created_at: 3000,
        started_at: null,
        completed_at: null,
      },
      {
        id: "m2",
        author_id: "p1",
        content: "2",
        source: "web",
        model: null,
        reasoning_effort: null,
        attachments: null,
        callback_context: null,
        status: "pending",
        error_message: null,
        created_at: 2000,
        started_at: null,
        completed_at: null,
      },
      {
        id: "m1",
        author_id: "p1",
        content: "1",
        source: "web",
        model: null,
        reasoning_effort: null,
        attachments: null,
        callback_context: null,
        status: "pending",
        error_message: null,
        created_at: 1000,
        started_at: null,
        completed_at: null,
      },
    ];
    vi.mocked(repository.listMessages).mockReturnValue(messages);

    const result = service.listMessages({ cursor: null, limit: 2, status: "pending" });

    expect(result.hasMore).toBe(true);
    expect(result.cursor).toBe("2000");
    expect(result.messages).toHaveLength(2);
    expect(repository.listMessages).toHaveBeenCalledWith({
      cursor: null,
      limit: 2,
      status: "pending",
    });
  });
});
