import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../../../logger";
import { AutofixHandler } from "./autofix.handler";

function createHandler() {
  const messageQueue = {
    enqueueAutofix: vi.fn(),
    lookupAutofix: vi.fn(),
  };
  const log = { error: vi.fn() } as unknown as Logger;
  return { handler: new AutofixHandler(messageQueue), messageQueue, log };
}

describe("AutofixHandler", () => {
  it("validates and dispatches Autofix admission commands", async () => {
    const { handler, messageQueue, log } = createHandler();
    messageQueue.enqueueAutofix.mockResolvedValue({
      kind: "enqueued",
      messageId: "msg-autofix",
    });
    const body = {
      type: "enqueue_feedback",
      feedbackKey: "github:99:review:1234",
      pullRequest: { repositoryId: "99", number: 42, artifactId: "artifact-1" },
      prompt: "Address the submitted review feedback.",
      author: { id: "7", login: "alice" },
      origin: {
        kind: "review",
        authorType: "human",
        feedbackUrl: "https://github.com/acme/widgets/pull/42#pullrequestreview-1234",
      },
      attemptLimit: 10,
    };

    const response = await handler.handle(
      new Request("http://internal/internal/autofix", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      log
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ kind: "enqueued", messageId: "msg-autofix" });
    expect(messageQueue.enqueueAutofix).toHaveBeenCalledWith(body);
  });

  it("dispatches Autofix recovery lookups", async () => {
    const { handler, messageQueue, log } = createHandler();
    messageQueue.lookupAutofix.mockResolvedValue({ kind: "found", messageId: "msg-autofix" });

    const response = await handler.handle(
      new Request("http://internal/internal/autofix", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "lookup_feedback",
          feedbackKey: "github:99:review:1234",
        }),
      }),
      log
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ kind: "found", messageId: "msg-autofix" });
    expect(messageQueue.lookupAutofix).toHaveBeenCalledWith("github:99:review:1234");
  });

  it("accepts Autofix admission commands without an attempt limit", async () => {
    const { handler, messageQueue, log } = createHandler();
    messageQueue.enqueueAutofix.mockResolvedValue({ kind: "enqueued", messageId: "msg-autofix" });
    const body = {
      type: "enqueue_feedback",
      feedbackKey: "github:99:review:1234",
      pullRequest: { repositoryId: "99", number: 42, artifactId: "artifact-1" },
      prompt: "Address the submitted review feedback.",
      author: { id: "7", login: "alice" },
      origin: {
        kind: "review",
        authorType: "human",
        feedbackUrl: "https://github.com/acme/widgets/pull/42#pullrequestreview-1234",
      },
      attemptLimit: null,
    };

    const response = await handler.handle(
      new Request("http://internal/internal/autofix", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      log
    );

    expect(response.status).toBe(200);
    expect(messageQueue.enqueueAutofix).toHaveBeenCalledWith(body);
  });

  it("rejects invalid Autofix commands before admission", async () => {
    const { handler, messageQueue, log } = createHandler();
    const response = await handler.handle(
      new Request("http://internal/internal/autofix", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "enqueue_feedback" }),
      }),
      log
    );

    expect(response.status).toBe(400);
    expect(messageQueue.enqueueAutofix).not.toHaveBeenCalled();
    expect(messageQueue.lookupAutofix).not.toHaveBeenCalled();
  });
});
