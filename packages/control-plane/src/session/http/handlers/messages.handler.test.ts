import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../../../logger";
import { createMessagesHandler } from "./messages.handler";
import type { MessageService } from "../../services/message.service";

function createHandler() {
  const messageService = {
    enqueuePrompt: vi.fn(),
    stop: vi.fn(),
    listEvents: vi.fn(),
    listArtifacts: vi.fn(),
    listMessages: vi.fn(),
  } as unknown as MessageService;

  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;

  return {
    handler: createMessagesHandler({
      messageService,
      getLog: () => log,
    }),
    messageService,
    log,
  };
}

describe("createMessagesHandler", () => {
  it("enqueues prompt and returns queued response", async () => {
    const { handler, messageService } = createHandler();
    vi.mocked(messageService.enqueuePrompt).mockResolvedValue({
      messageId: "msg-1",
      status: "queued",
    });

    const response = await handler.enqueuePrompt(
      new Request("http://internal/internal/prompt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: "hello",
          authorId: "user-1",
          source: "web",
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ messageId: "msg-1", status: "queued" });
    expect(messageService.enqueuePrompt).toHaveBeenCalledWith({
      content: "hello",
      authorId: "user-1",
      source: "web",
    });
  });

  it("logs and rethrows when enqueue prompt parsing fails", async () => {
    const { handler, log } = createHandler();

    await expect(
      handler.enqueuePrompt(
        new Request("http://internal/internal/prompt", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{invalid",
        })
      )
    ).rejects.toBeTruthy();

    expect(log.error).toHaveBeenCalledWith(
      "handleEnqueuePrompt error",
      expect.objectContaining({ error: expect.anything() })
    );
  });

  it("returns 400 for invalid event type", async () => {
    const { handler } = createHandler();

    const response = handler.listEvents(new URL("http://internal/internal/events?type=invalid"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid event type: invalid" });
  });

  it("maps listEvents response", async () => {
    const { handler, messageService } = createHandler();
    vi.mocked(messageService.listEvents).mockReturnValue({
      events: [
        {
          id: "e1",
          type: "token",
          data: '{"x":1}',
          message_id: "m1",
          created_at: 1000,
        },
      ],
      cursor: "1000",
      hasMore: false,
    });

    const response = handler.listEvents(new URL("http://internal/internal/events?limit=10"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      events: [{ id: "e1", type: "token", data: { x: 1 }, messageId: "m1", createdAt: 1000 }],
      cursor: "1000",
      hasMore: false,
    });
  });

  it("returns artifacts from service unchanged", async () => {
    const { handler, messageService } = createHandler();
    vi.mocked(messageService.listArtifacts).mockReturnValue({
      artifacts: [
        {
          id: "a1",
          type: "pr",
          url: "https://example.com",
          metadata: null,
          createdAt: 1,
        },
      ],
    });

    const response = handler.listArtifacts();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      artifacts: [
        {
          id: "a1",
          type: "pr",
          url: "https://example.com",
          metadata: null,
          createdAt: 1,
        },
      ],
    });
  });

  it("returns 400 for invalid message status", async () => {
    const { handler } = createHandler();

    const response = handler.listMessages(
      new URL("http://internal/internal/messages?status=invalid")
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid message status: invalid" });
  });

  it("maps listMessages response", async () => {
    const { handler, messageService } = createHandler();
    vi.mocked(messageService.listMessages).mockReturnValue({
      messages: [
        {
          id: "m1",
          author_id: "p1",
          content: "hello",
          source: "web",
          model: null,
          reasoning_effort: null,
          attachments: null,
          callback_context: null,
          status: "completed",
          error_message: null,
          created_at: 1000,
          started_at: 1100,
          completed_at: 1200,
        },
      ],
      cursor: "1000",
      hasMore: false,
    });

    const response = handler.listMessages(new URL("http://internal/internal/messages?limit=10"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      messages: [
        {
          id: "m1",
          authorId: "p1",
          content: "hello",
          source: "web",
          status: "completed",
          createdAt: 1000,
          startedAt: 1100,
          completedAt: 1200,
        },
      ],
      cursor: "1000",
      hasMore: false,
    });
  });

  it("returns stopping status for stop endpoint", async () => {
    const { handler, messageService } = createHandler();
    vi.mocked(messageService.stop).mockResolvedValue({ status: "stopping" });

    const response = await handler.stop();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "stopping" });
  });
});
