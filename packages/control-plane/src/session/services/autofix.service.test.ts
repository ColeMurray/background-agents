import { describe, expect, it, vi } from "vitest";
import type { SessionMessageQueue } from "../message-queue";
import { SessionAutofixService } from "./autofix.service";

function createService() {
  const messageQueue = {
    enqueueAutofix: vi.fn(),
    lookupAutofix: vi.fn(),
  } as unknown as SessionMessageQueue;

  return {
    service: new SessionAutofixService(messageQueue),
    messageQueue,
  };
}

describe("SessionAutofixService", () => {
  it("delegates feedback admission to the session message queue", async () => {
    const { service, messageQueue } = createService();
    vi.mocked(messageQueue.enqueueAutofix).mockResolvedValue({
      kind: "enqueued",
      messageId: "msg-autofix",
    });
    const command = {
      type: "enqueue_feedback" as const,
      feedbackKey: "github:99:review:1234",
      pullRequest: { repositoryId: "99", number: 42, artifactId: "artifact-1" },
      prompt: "Address the submitted review feedback.",
      author: { id: "7", login: "alice" },
      origin: {
        kind: "review" as const,
        authorType: "human" as const,
        feedbackUrl: "https://github.com/acme/widgets/pull/42#pullrequestreview-1234",
      },
      attemptLimit: 10,
    };

    await expect(service.handle(command)).resolves.toEqual({
      kind: "enqueued",
      messageId: "msg-autofix",
    });
    expect(messageQueue.enqueueAutofix).toHaveBeenCalledWith(command);
  });

  it("delegates recovery lookup so pending work is re-driven", async () => {
    const { service, messageQueue } = createService();
    vi.mocked(messageQueue.lookupAutofix).mockResolvedValue({
      kind: "found",
      messageId: "msg-autofix",
    });

    await expect(
      service.handle({
        type: "lookup_feedback",
        feedbackKey: "github:99:review:1234",
      })
    ).resolves.toEqual({ kind: "found", messageId: "msg-autofix" });
    expect(messageQueue.lookupAutofix).toHaveBeenCalledWith("github:99:review:1234");
  });
});
